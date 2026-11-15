import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';

// SQLite commits the durable claim before any provider POST. All stored values
// (including paper/reference input) are encrypted with a server-local key.
export function openStore(directory){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const keyPath=join(directory,'encryption.key');
  try{writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  const key=readFileSync(keyPath);if(key.length!==32)throw Error('Invalid storage key');
  const db=new DatabaseSync(join(directory,'jobs.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (namespace TEXT, key TEXT, value BLOB, PRIMARY KEY(namespace,key)); CREATE TABLE IF NOT EXISTS alarms (namespace TEXT PRIMARY KEY, at INTEGER)');
  const encode=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,encrypt(c,value)]);};
  function encrypt(c,value){const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([c.getAuthTag(),data]);}
  const decode=value=>{if(!value)return undefined;const b=Buffer.from(value),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());};
  const get=(ns,k)=>decode(db.prepare('SELECT value FROM kv WHERE namespace=? AND key=?').get(ns,k)?.value);
  const put=(ns,k,v)=>db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?,?)').run(ns,k,encode(v));
  const del=(ns,k)=>db.prepare('DELETE FROM kv WHERE namespace=? AND key=?').run(ns,k);
  const alarm=(ns,at)=>at===null?db.prepare('DELETE FROM alarms WHERE namespace=?').run(ns):db.prepare('INSERT OR REPLACE INTO alarms VALUES (?,?)').run(ns,at);
  const locks=new Map();
  function lock(name,fn){const p=(locks.get(name)||Promise.resolve()).then(fn);const tail=p.catch(()=>{});locks.set(name,tail);tail.finally(()=>{if(locks.get(name)===tail)locks.delete(name);});return p;}
  function storage(ns){
    const api={
      async get(k){return get(ns,k);},async put(k,v){put(ns,k,v);},
      async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])del(ns,k);},
      async list({prefix='',limit=128}={}){return new Map(db.prepare('SELECT key,value FROM kv WHERE namespace=? AND substr(key,1,?)=? ORDER BY key LIMIT ?').all(ns,prefix.length,prefix,limit).map(r=>[r.key,decode(r.value)]));},
      async setAlarm(at){alarm(ns,at);},async deleteAlarm(){alarm(ns,null);},
      async transaction(fn){return lock('tx:'+ns,async()=>{
        const pending=new Map();let nextAlarm;
        const tx={...api,async get(k){return pending.has(k)?pending.get(k):get(ns,k);},async put(k,v){pending.set(k,v);},async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])pending.set(k,undefined);},async setAlarm(at){nextAlarm=at;},async deleteAlarm(){nextAlarm=null;}};
        const result=await fn(tx);
        db.exec('BEGIN IMMEDIATE');try{for(const [k,v] of pending)v===undefined?del(ns,k):put(ns,k,v);if(nextAlarm!==undefined)alarm(ns,nextAlarm);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        return result;
      });}
    };return api;
  }
  return {storage,lock,key:key.toString('base64'),
    due:()=>db.prepare('SELECT namespace FROM alarms WHERE at<=? ORDER BY at LIMIT 100').all(Date.now()).map(r=>r.namespace),
    recover(){for(const {namespace} of db.prepare("SELECT namespace FROM kv WHERE key='meta'").all()){const meta=get(namespace,'meta');if(['queued','running','response_received'].includes(meta?.state))alarm(namespace,Date.now());}},
    close:()=>db.close()};
}
