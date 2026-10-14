/* Terrain — sync safety tests.

   The fake backend enforces NOTHING on its own beyond the one thing a real
   backend genuinely does: a conditional update matches zero rows when the
   revision has moved. It will happily let a caller insert over an existing
   row or write a lower revision if the client logic asks it to. Every other
   guarantee here has to come from sync-core.js.

   Run: node --test test/
*/
const test=require('node:test');
const assert=require('node:assert');
const {createSync,MAX_SNAPSHOTS}=require('../sync-core.js');

/* ---- fakes ------------------------------------------------------------ */
function makeBackend(initial){
  return {
    row: initial?{rev:initial.rev,data:initial.data}:null,
    writes: 0,
    casAttempts: 0,
    // hook: run just before a CAS lands, to simulate another device winning
    beforeCas: null,
    async fetch(){ return this.row?{rev:this.row.rev,data:this.row.data}:null; },
    async insert({rev,data}){
      if(this.row)return {ok:false,conflict:true};   // PK collision, the one real constraint
      this.row={rev,data}; this.writes++; return {ok:true};
    },
    async casUpdate({baseRev,rev,data}){
      this.casAttempts++;
      if(this.beforeCas){ const f=this.beforeCas; this.beforeCas=null; await f(this); }
      if(!this.row||this.row.rev!==baseRev)return {ok:false};   // zero rows matched
      this.row={rev,data}; this.writes++; return {ok:true};
    }
  };
}

function makeStore(stateObj,meta){
  return {
    state: stateObj?JSON.stringify(stateObj):null,
    meta: Object.assign({},meta),
    async getState(){ return this.state; },
    async setState(json){ this.state=json; },
    async getMeta(k){ return Object.prototype.hasOwnProperty.call(this.meta,k)?this.meta[k]:null; },
    async setMeta(k,v){ this.meta[k]=v; },
    async delMeta(k){ delete this.meta[k]; }
  };
}

function harness({local,localMeta,cloud,clock}){
  const backend=makeBackend(cloud);
  const store=makeStore(local,localMeta);
  const notices=[]; const adopted=[];
  let t=clock||1000;
  const sync=createSync({
    backend, store,
    now:()=>++t,
    notify:(m,k)=>notices.push({m,k}),
    onAdopt:s=>adopted.push(s)
  });
  return {sync,backend,store,notices,adopted,
    localState:()=>JSON.parse(store.state),
    cloudState:()=>backend.row?JSON.parse(backend.row.data):null,
    snaps:async()=>await sync.listSnapshots()};
}

const DAY=86400000;

/* ---- (a) the incident -------------------------------------------------- */
test('(a) stale dirty device coming back online cannot overwrite newer cloud data',async()=>{
  // Device A: edited offline days ago, still flagged dirty, baseline rev 100.
  // Device B has since pushed four more times; the cloud is at rev 140.
  const h=harness({
    local:{note:'A offline edit',updatedAt:Date.now()+DAY},   // clock skew: local LOOKS newer
    localMeta:{rev:'100',dirty:'1'},
    cloud:{rev:140,data:JSON.stringify({note:'B days of work',updatedAt:Date.now()})}
  });

  const res=await h.sync.connect();

  assert.strictEqual(res.status,'adopted');
  assert.strictEqual(res.reason,'conflict');
  assert.strictEqual(h.backend.writes,0,'cloud must not be written at all');
  assert.strictEqual(h.cloudState().note,'B days of work','cloud data unchanged');
  assert.strictEqual(h.localState().note,'B days of work','device adopted the cloud copy');
  assert.strictEqual(await h.sync.getBase(),140,'baseline realigned to the cloud revision');
  assert.strictEqual(await h.sync.isDirty(),false,'stale payload is not queued for retry');

  const snaps=await h.snaps();
  assert.strictEqual(snaps.length,1,'a backup was written before the overwrite');
  assert.strictEqual(JSON.parse(await h.store.getMeta(snaps[0].id)).note,'A offline edit',
    'the backup holds what the device was about to lose');
  assert.strictEqual(h.notices.length,1,'user was told');
  assert.match(h.notices[0].m,/another device updated your data first/i);
});

test('(a2) a losing device does not re-push its stale payload on the next save',async()=>{
  const h=harness({
    local:{note:'stale'},localMeta:{rev:'100',dirty:'1'},
    cloud:{rev:140,data:JSON.stringify({note:'newer'})}
  });
  await h.sync.connect();
  const after=await h.sync.pushIfDirty(h.localState());
  assert.strictEqual(after.status,'clean','nothing left pending after adopting');
  assert.strictEqual(h.backend.writes,0);
  assert.strictEqual(h.cloudState().note,'newer');
});

/* ---- (b) the normal case still works ----------------------------------- */
test('(b) an edit based on the current revision still pushes',async()=>{
  const h=harness({
    local:{note:'old'},localMeta:{rev:'140'},
    cloud:{rev:140,data:JSON.stringify({note:'old'})}
  });
  const res=await h.sync.push({note:'my new edit'});
  assert.strictEqual(res.status,'pushed');
  assert.strictEqual(h.cloudState().note,'my new edit');
  assert.ok(h.backend.row.rev>140,'revision advanced');
  assert.strictEqual(await h.sync.getBase(),h.backend.row.rev);
  assert.strictEqual(await h.sync.isDirty(),false);
  assert.strictEqual(h.notices.length,0,'no scary notice for the happy path');
});

test('(b2) connect fast-forwards a dirty device that is already on the current revision',async()=>{
  const h=harness({
    local:{note:'local edit while current'},localMeta:{rev:'140',dirty:'1'},
    cloud:{rev:140,data:JSON.stringify({note:'old'})}
  });
  const res=await h.sync.connect();
  assert.strictEqual(res.status,'pushed');
  assert.strictEqual(h.cloudState().note,'local edit while current');
  assert.strictEqual((await h.snaps()).length,0,'no overwrite happened, so no backup needed');
});

/* ---- (c) losing the race mid-push -------------------------------------- */
test('(c) a push that loses the CAS race leaves the cloud untouched and adopts',async()=>{
  const h=harness({
    local:{note:'mine'},localMeta:{rev:'140'},
    cloud:{rev:140,data:JSON.stringify({note:'mine'})}
  });
  // Another device lands a write in the window between our fetch and our CAS.
  h.backend.beforeCas=async b=>{ b.row={rev:141,data:JSON.stringify({note:'other device won'})}; };

  const res=await h.sync.push({note:'my doomed edit'});

  assert.strictEqual(res.status,'adopted');
  assert.strictEqual(res.reason,'conflict');
  assert.strictEqual(h.backend.casAttempts,1,'tried once');
  assert.strictEqual(h.cloudState().note,'other device won','the winner stands');
  assert.strictEqual(h.localState().note,'other device won');
  assert.strictEqual(await h.sync.getBase(),141);
  assert.strictEqual(await h.sync.isDirty(),false,'no retry of the losing payload');
  const snaps=await h.snaps();
  assert.ok(snaps.length>=1);
  assert.strictEqual(h.notices.length,1);
});

/* ---- (d) clean catch-up ------------------------------------------------ */
test('(d) a clean stale device catches up without writing anything',async()=>{
  const h=harness({
    local:{note:'old'},localMeta:{rev:'100'},        // no dirty flag
    cloud:{rev:140,data:JSON.stringify({note:'newer'})}
  });
  const res=await h.sync.connect();
  assert.strictEqual(res.status,'adopted');
  assert.strictEqual(res.reason,'catch-up');
  assert.strictEqual(h.backend.writes,0,'a reader never writes');
  assert.strictEqual(h.localState().note,'newer');
  assert.strictEqual(await h.sync.getBase(),140);
  assert.strictEqual((await h.snaps()).length,1,'still backed up before replacing local state');
  assert.strictEqual(h.notices.length,0,'nothing was at risk, so no alarm');
});

test('(d2) a clean device already on the current revision does nothing',async()=>{
  const h=harness({
    local:{note:'same'},localMeta:{rev:'140'},
    cloud:{rev:140,data:JSON.stringify({note:'same'})}
  });
  const res=await h.sync.connect();
  assert.strictEqual(res.status,'current');
  assert.strictEqual(h.backend.writes,0);
  assert.strictEqual((await h.snaps()).length,0);
});

/* ---- (e) first ever sync ----------------------------------------------- */
test('(e) first-ever sync seeds an empty cloud',async()=>{
  const h=harness({local:{note:'brand new device'},localMeta:{},cloud:null});
  const res=await h.sync.connect();
  assert.strictEqual(res.status,'seeded');
  assert.strictEqual(h.cloudState().note,'brand new device');
  assert.strictEqual(await h.sync.getBase(),h.backend.row.rev);
  assert.strictEqual(await h.sync.isDirty(),false);
});

test('(e2) seeding loses to a device that seeded first, and does not clobber it',async()=>{
  const h=harness({local:{note:'mine'},localMeta:{},cloud:null});
  const original=h.backend.insert.bind(h.backend);
  h.backend.insert=async function(row){            // another device seeds first
    this.row={rev:5,data:JSON.stringify({note:'they seeded first'})};
    return await original(row);
  };
  const res=await h.sync.connect();
  assert.strictEqual(res.status,'adopted');
  assert.strictEqual(h.cloudState().note,'they seeded first');
  assert.strictEqual(h.localState().note,'they seeded first');
});

/* ---- (f) import clock / heal flag -------------------------------------- */
test('(f) adopting a copy older in import-clock terms raises the heal flag',async()=>{
  const h=harness({
    local:{note:'local',importClock:900},
    localMeta:{rev:'100',dirty:'1'},
    cloud:{rev:140,data:JSON.stringify({note:'cloud',importClock:400})}
  });
  const res=await h.sync.connect();
  assert.strictEqual(res.healed,true);
  const heal=await h.sync.getHeal();
  assert.deepStrictEqual({from:heal.from,to:heal.to},{from:400,to:900},
    'records the window an external cursor has already moved past');
  await h.sync.clearHeal();
  assert.strictEqual(await h.sync.getHeal(),null);
});

test('(f2) adopting a copy that is not behind raises no heal flag',async()=>{
  const h=harness({
    local:{importClock:400},localMeta:{rev:'100'},
    cloud:{rev:140,data:JSON.stringify({importClock:900})}
  });
  const res=await h.sync.connect();
  assert.strictEqual(res.healed,false);
  assert.strictEqual(await h.sync.getHeal(),null);
});

test('(f3) restoring an older snapshot also raises the heal flag',async()=>{
  const h=harness({
    local:{note:'current',importClock:900},localMeta:{rev:'140'},
    cloud:{rev:140,data:JSON.stringify({note:'current',importClock:900})}
  });
  await h.store.setMeta('snap:old',JSON.stringify({note:'restored',importClock:100}));
  const r=await h.sync.restoreSnapshot('snap:old');
  assert.strictEqual(r.ok,true);
  assert.strictEqual(h.localState().note,'restored');
  assert.strictEqual((await h.sync.getHeal()).to,900);
  assert.strictEqual(await h.sync.isDirty(),true,'a restore still needs to reach the cloud');
});

/* ---- migration safety --------------------------------------------------- */
test('upgrade day: a device with no baseline treats the cloud revision as its baseline',async()=>{
  const h=harness({
    local:{note:'identical'},localMeta:{},                       // no stored rev
    cloud:{rev:77,data:JSON.stringify({note:'identical'})}
  });
  const res=await h.sync.connect();
  assert.strictEqual(res.status,'aligned');
  assert.strictEqual(await h.sync.getBase(),77);
  assert.strictEqual(h.backend.writes,0,'existing cloud data is not rewritten');
  assert.strictEqual((await h.snaps()).length,0);
});

test('upgrade day: differing local content is backed up, not pushed over the cloud',async()=>{
  const h=harness({
    local:{note:'local only'},localMeta:{},
    cloud:{rev:77,data:JSON.stringify({note:'cloud'})}
  });
  const res=await h.sync.connect();
  assert.strictEqual(res.reason,'baseline');
  assert.strictEqual(h.backend.writes,0);
  assert.strictEqual(h.cloudState().note,'cloud');
  assert.strictEqual(JSON.parse(await h.store.getMeta((await h.snaps())[0].id)).note,'local only');
});

/* ---- realtime ----------------------------------------------------------- */
test('a realtime update from another device is adopted, after a backup',async()=>{
  const h=harness({
    local:{note:'mine'},localMeta:{rev:'140'},
    cloud:{rev:140,data:JSON.stringify({note:'mine'})}
  });
  const res=await h.sync.onRemote({rev:141,data:JSON.stringify({note:'from phone'})});
  assert.strictEqual(res.status,'adopted');
  assert.strictEqual(h.localState().note,'from phone');
  assert.strictEqual(await h.sync.getBase(),141);
  assert.strictEqual((await h.snaps()).length,1);
});

test('a realtime echo of our own revision is ignored',async()=>{
  const h=harness({
    local:{note:'mine'},localMeta:{rev:'140'},
    cloud:{rev:140,data:JSON.stringify({note:'mine'})}
  });
  const res=await h.sync.onRemote({rev:140,data:JSON.stringify({note:'mine'})});
  assert.strictEqual(res.status,'ignored');
  assert.strictEqual((await h.snaps()).length,0);
});

/* ---- revisions and the backup ring -------------------------------------- */
test('revisions advance even when the device clock is wrong',async()=>{
  const h=harness({local:{},localMeta:{rev:'0'},cloud:null,clock:1000});
  // base far ahead of our clock, as if another device had a fast clock
  assert.ok(h.sync.nextRev(9e14)>9e14,'never flat or backwards');
  assert.ok(h.sync.nextRev(0)>0);
});

test('the snapshot ring is capped and keeps the newest',async()=>{
  const h=harness({local:{n:0},localMeta:{rev:'1'},cloud:{rev:1,data:'{"n":0}'}});
  for(let i=1;i<=MAX_SNAPSHOTS+4;i++){ await h.store.setState(JSON.stringify({n:i})); await h.sync.snapshot('test'+i); }
  const snaps=await h.snaps();
  assert.strictEqual(snaps.length,MAX_SNAPSHOTS);
  assert.strictEqual(snaps[0].reason,'test'+(MAX_SNAPSHOTS+4),'newest first');
  for(const s of snaps)assert.ok(await h.store.getMeta(s.id),'listed snapshots still exist');
});

test('a snapshot can be restored',async()=>{
  const h=harness({local:{note:'v1'},localMeta:{rev:'1'},cloud:{rev:1,data:'{"note":"v1"}'}});
  const id=await h.sync.snapshot('manual');
  await h.store.setState(JSON.stringify({note:'v2'}));
  const r=await h.sync.restoreSnapshot(id);
  assert.strictEqual(r.ok,true);
  assert.strictEqual(h.localState().note,'v1');
  const snaps=await h.snaps();
  assert.ok(snaps.some(s=>s.reason==='before-restore'),'what was replaced is itself kept');
});
