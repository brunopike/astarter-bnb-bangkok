import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {homedir} from 'node:os';

export function memoryFeedbackPath(){
 return process.env.ASTARTER_MEMORY_DB||`${homedir()}/.config/astarter/memory-feedback.sqlite`;
}

export function createMemoryFeedbackStore(file=memoryFeedbackPath()){
 if(file!==':memory:')mkdirSync(dirname(file),{recursive:true,mode:0o700});
 const db=new DatabaseSync(file);
 if(file!==':memory:')chmodSync(file,0o600);
 db.exec(`CREATE TABLE IF NOT EXISTS memory_responses (
  id INTEGER PRIMARY KEY,
  requester TEXT NOT NULL,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
 )`);
 const insert=db.prepare(`INSERT INTO memory_responses (requester,kind,query,slug,payload,created_at) VALUES (?,?,?,?,?,?)`);
 const recent=db.prepare(`SELECT id,kind,query,slug,payload,created_at FROM memory_responses WHERE requester=? ORDER BY id DESC LIMIT ?`);
 const history=db.prepare(`SELECT id,kind,query,slug,payload,created_at FROM memory_responses WHERE requester=? ORDER BY id`);
 const map=row=>({id:row.id,kind:row.kind,query:row.query,slug:row.slug,payload:JSON.parse(row.payload),createdAt:row.created_at});
 return {
  save(row){
   const created=new Date().toISOString();
   const info=insert.run(row.requester,row.kind,row.query,row.slug||'',JSON.stringify(row.payload),created);
   return Number(info.lastInsertRowid);
  },
  list(requester,limit=20){
   return recent.all(requester,limit).map(map);
  },
  all(requester){
   return history.all(requester).map(map);
  },
  close(){db.close();}
 };
}
