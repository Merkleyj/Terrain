/* Terrain — sync core.
   Conflict and push logic for the cloud record, kept free of DOM, Supabase and
   localStorage so the same code the app ships can be driven by a fake backend
   in tests.

   The rule this exists to enforce: a device may only overwrite the cloud when
   it can prove it is building on the cloud's current revision. Never because
   it believes its own copy is newer — a stale device with a fast clock
   believes exactly that, and that is how days of work disappear.

   Revision: the existing `updated_at` column is the monotonic revision, so no
   schema change and no touching of existing rows is required. A new revision
   is max(base+1, now) — still roughly a timestamp, but never flat or going
   backwards when a device's clock is wrong.

   Adapters (all async unless noted):
     backend.fetch()                      -> null | {rev:Number, data:String}
     backend.insert({rev,data})           -> {ok:true} | {ok:false,conflict:true}
     backend.casUpdate({baseRev,rev,data})-> {ok:Boolean}   false = lost the race
     store.getState() / setState(json)
     store.getMeta(k) / setMeta(k,v) / delMeta(k)
     now()            -> ms                                        (sync)
     notify(msg,kind)                                               (sync)
     onAdopt(stateObj)  applies adopted state to the running app    (sync)
     importClockOf(st)  -> Number, how far an importer has consumed (sync)
*/
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.SyncCore=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';

var MAX_SNAPSHOTS=10;
var K_REV='rev', K_DIRTY='dirty', K_SNAPS='snaps', K_HEAL='heal';

function parse(json){ if(!json)return null; try{return JSON.parse(json);}catch(e){return null;} }

function createSync(opt){
  var backend=opt.backend, store=opt.store;
  var now=opt.now||function(){return Date.now();};
  var notify=opt.notify||function(){};
  var onAdopt=opt.onAdopt||function(){};
  var importClockOf=opt.importClockOf||function(st){return st&&+st.importClock||0;};

  function nextRev(base){ return Math.max((+base||0)+1, now()); }

  async function getBase(){
    var v=await store.getMeta(K_REV);
    return v==null||v===''?null:+v;      // null = this device has no baseline yet
  }
  async function setBase(rev){ await store.setMeta(K_REV,String(rev)); }
  async function isDirty(){ return !!(await store.getMeta(K_DIRTY)); }
  async function markDirty(){ await store.setMeta(K_DIRTY,'1'); }
  async function clearDirty(){ await store.delMeta(K_DIRTY); }

  /* ---- local snapshot ring -------------------------------------------- */
  async function listSnapshots(){ return parse(await store.getMeta(K_SNAPS))||[]; }

  async function snapshot(reason){
    var json=await store.getState();
    if(!json)return null;
    var list=await listSnapshots();
    var ts=now(), id='snap:'+ts+':'+Math.random().toString(36).slice(2,7);
    await store.setMeta(id,json);
    list.unshift({id:id,ts:ts,reason:reason||'backup',bytes:json.length});
    while(list.length>MAX_SNAPSHOTS){ var drop=list.pop(); try{await store.delMeta(drop.id);}catch(e){} }
    await store.setMeta(K_SNAPS,JSON.stringify(list));
    return id;
  }

  async function restoreSnapshot(id){
    var json=await store.getMeta(id);
    if(!json)return {ok:false,reason:'missing'};
    var incoming=parse(json);
    if(!incoming)return {ok:false,reason:'unreadable'};
    await snapshot('before-restore');          // the copy being replaced is itself worth keeping
    await noteHealIfBehind(incoming);
    await store.setState(json);
    await markDirty();                          // a restore is a local change that must reach the cloud
    onAdopt(incoming);
    return {ok:true};
  }

  /* ---- external-importer heal flag ------------------------------------
     Terrain has no external importer today. The hook is here because the
     failure it prevents is silent and unrecoverable: if state is ever
     replaced by a copy whose import clock is older, an external cursor has
     already moved past records this copy never saw, and nothing will ever
     re-deliver them. Any importer added later must consult getHeal() and
     re-import that range, and must never acknowledge its cursor until the
     state containing the import has actually landed in the cloud. */
  async function noteHealIfBehind(incoming){
    var cur=parse(await store.getState());
    var was=importClockOf(cur), will=importClockOf(incoming);
    if(was>will){
      await store.setMeta(K_HEAL,JSON.stringify({from:will,to:was,at:now()}));
      return true;
    }
    return false;
  }
  async function getHeal(){ return parse(await store.getMeta(K_HEAL)); }
  async function clearHeal(){ await store.delMeta(K_HEAL); }

  /* ---- adopting the cloud copy ---------------------------------------- */
  async function adopt(remote,reason){
    var incoming=parse(remote.data);
    if(!incoming)return {status:'unreadable'};
    await snapshot('before-'+reason);          // back up before every overwrite
    var healed=await noteHealIfBehind(incoming);
    await store.setState(remote.data);
    await setBase(remote.rev);
    await clearDirty();                         // the losing payload is never retried
    onAdopt(incoming);
    if(reason==='conflict')notify('Another device updated your data first — your local copy was backed up and can be restored in Settings.','warn');
    return {status:'adopted',reason:reason,healed:healed};
  }

  /* ---- first contact after sign-in ------------------------------------ */
  async function connect(){
    var remote=await backend.fetch();
    var localJson=await store.getState();
    var base=await getBase();

    if(!remote){                                 // nothing in the cloud yet — seed it
      var rev=nextRev(0);
      var r=await backend.insert({rev:rev,data:localJson||'{}'});
      if(r&&r.ok){ await setBase(rev); await clearDirty(); return {status:'seeded',rev:rev}; }
      var again=await backend.fetch();           // someone seeded it between our read and write
      if(again)return await adopt(again,'conflict');
      return {status:'error'};
    }

    if(base==null){
      /* Upgrade day: this device has never recorded a baseline, so it cannot
         prove anything about its local copy. Identical content needs no
         ceremony; otherwise the cloud is the baseline and the local copy is
         kept as a snapshot rather than pushed over the top. */
      if(localJson===remote.data){ await setBase(remote.rev); await clearDirty(); return {status:'aligned',rev:remote.rev}; }
      return await adopt(remote,'baseline');
    }

    if(base===remote.rev){
      if(await isDirty())return await push(parse(localJson));
      return {status:'current',rev:remote.rev};   // clean and up to date: no write at all
    }

    /* Behind the cloud. Clean devices just catch up; a dirty one has lost and
       is told so. Either way the local copy is snapshotted first. */
    return await adopt(remote,(await isDirty())?'conflict':'catch-up');
  }

  /* ---- pushing -------------------------------------------------------- */
  async function push(stateObj){
    await markDirty();
    var json=JSON.stringify(stateObj);
    var base=await getBase();
    var remote=await backend.fetch();            // pull-and-reconcile before every push

    if(!remote){
      var rev0=nextRev(base||0);
      var ins=await backend.insert({rev:rev0,data:json});
      if(ins&&ins.ok){ await store.setState(json); await setBase(rev0); await clearDirty(); return {status:'pushed',rev:rev0}; }
      var seeded=await backend.fetch();
      if(seeded)return await adopt(seeded,'conflict');
      return {status:'error'};
    }

    if(base==null||base!==remote.rev){
      /* Built on something other than what the cloud holds. A dirty flag is
         not permission to overwrite — the cloud wins and the local copy is
         backed up. */
      return await adopt(remote,'conflict');
    }

    var rev=nextRev(Math.max(base,remote.rev));
    var res=await backend.casUpdate({baseRev:base,rev:rev,data:json});
    if(res&&res.ok){
      await store.setState(json);
      await setBase(rev);
      await clearDirty();
      return {status:'pushed',rev:rev};
    }
    var fresh=await backend.fetch();             // lost the race between fetch and write
    if(fresh)return await adopt(fresh,'conflict');
    return {status:'error'};
  }

  async function pushIfDirty(stateObj){
    if(!(await isDirty()))return {status:'clean'};
    return await push(stateObj);
  }

  /* A realtime notification of someone else's write. Same rule: anything that
     isn't our own baseline is adopted, after a snapshot. */
  async function onRemote(remote){
    if(!remote)return {status:'ignored'};
    var base=await getBase();
    if(base!=null&&remote.rev===base)return {status:'ignored'};
    return await adopt(remote,(await isDirty())?'conflict':'catch-up');
  }

  return {
    connect:connect, push:push, pushIfDirty:pushIfDirty, onRemote:onRemote,
    adopt:adopt, snapshot:snapshot, listSnapshots:listSnapshots, restoreSnapshot:restoreSnapshot,
    getHeal:getHeal, clearHeal:clearHeal,
    markDirty:markDirty, isDirty:isDirty, getBase:getBase, setBase:setBase,
    nextRev:nextRev
  };
}

return {createSync:createSync, MAX_SNAPSHOTS:MAX_SNAPSHOTS};
});
