import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';

const fields=['ASTARTER_TELEGRAM_BOT_TOKEN','ASTARTER_RESEND_API_KEY','ASTARTER_NOTIFICATION_FROM'];

export function loadNotificationConfig({env=process.env,configFile=join(homedir(),'.config','astarter','.env'),legacyFile}={}){
 for(const file of [configFile,legacyFile].filter(Boolean)){
  if(fields.every(key=>Object.hasOwn(env,key)))return;
  let text;
  try{text=readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const values=parseEnv(text);
  for(const key of fields)if(!Object.hasOwn(env,key)&&Object.hasOwn(values,key))env[key]=values[key];
 }
}
