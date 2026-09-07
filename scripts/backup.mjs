// Encrypted application-data backup. Restoration runs only in a disposable local PostgreSQL engine.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createDatabase } from '../web/tests/db-fixture.mjs';

const directory=new URL('../.backups/',import.meta.url);
const keyFile=new URL('encryption.key',directory);
const magic=Buffer.from('SBB1');
async function key() {
  const raw=process.env.PORTFOLIO_BACKUP_KEY ?? await readFile(keyFile,'utf8');
  if (!/^[a-f0-9]{64}$/.test(raw.trim())) throw new Error('Invalid backup key');
  return Buffer.from(raw.trim(),'hex');
}
async function verify(encrypted) {
  if (!encrypted.subarray(0,4).equals(magic)) throw new Error('Invalid archive');
  const decipher=createDecipheriv('aes-256-gcm',await key(),encrypted.subarray(4,16));
  decipher.setAAD(magic);decipher.setAuthTag(encrypted.subarray(-16));
  const archive=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16,-16)),decipher.final()]).toString());
  const portfolios=archive.portfolios.map(text=>({text,parsed:JSON.parse(text)}));
  const db=await createDatabase(portfolios.map(row=>row.parsed.owner_id));
  try {
    for (const {text,parsed} of portfolios) {
      const owner=parsed.owner_id;
      const empty=JSON.parse((await db.query('select export_portfolio($1) as data',[owner])).rows[0].data);
      await db.query('select restore_portfolio($1,$2,$3,true)',[owner,text,empty.fingerprint]);
      const restored=JSON.parse((await db.query('select export_portfolio($1) as data',[owner])).rows[0].data);
      // PostgreSQL collation may reorder rows across hosts; compare every row, not array order.
      const canonical=rows=>JSON.stringify(rows.map(row=>JSON.stringify(row,(field,value)=>{
        if(typeof value==='string' && field.endsWith('_at')) {
          const timestamp=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.(\d+))?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
          // Normalize timezone notation without discarding PostgreSQL microseconds.
          if(timestamp)return new Date(value).toISOString().slice(0,19)+'.'+(timestamp[1]??'').padEnd(6,'0')+'Z';
        }
        return value;
      })).sort());
      const tables=Object.keys(parsed.data).filter(name=>canonical(restored.data[name])!==canonical(parsed.data[name]));
      if (tables.length) {
        console.error('Restore comparison differs in tables: '+tables.join(', ')+' (values withheld)');
        throw new Error('Restored data mismatch');
      }
    }
  } finally {await db.close();}
  console.log(`PASS: encrypted backup restored and compared for ${portfolios.length} account(s); no production writes`);
}
async function main() {
  const mode=process.argv[2];
  await mkdir(directory,{recursive:true,mode:0o700});
  if (mode==='init-key') {
    let value;
    try {value=await readFile(keyFile,'utf8');} catch (error) {if(error.code!=='ENOENT')throw error;value=randomBytes(32).toString('hex');await writeFile(keyFile,value,{mode:0o600,flag:'wx'});}
    const result=spawnSync('gh',['secret','set','PORTFOLIO_BACKUP_KEY','--repo','Felix0708/stock-briefing'],{input:value,encoding:'utf8',stdio:['pipe','ignore','pipe']});
    if (result.status!==0) throw new Error('Could not configure backup secret');
    console.log('PASS: private local encryption key and GitHub Actions secret configured (key not displayed)');
    return;
  }
  if (mode==='verify') {await verify(await readFile(process.argv[3]));return;}
  if (mode!=='create') throw new Error('Use init-key, create, or verify <file>');
  if (!process.env.SUPABASE_URL) process.loadEnvFile(new URL('../.env',import.meta.url));
  const url=process.env.SUPABASE_URL,secret=process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error('Missing backup server configuration');
  const headers={apikey:secret,'Content-Type':'application/json',...(!secret.startsWith('sb_secret_')?{Authorization:`Bearer ${secret}`}:{})};
  async function get(path,body) {
    const response=await fetch(url+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`Backup service returned HTTP ${response.status}`);
    return response.json();
  }
  const portfolios=[];
  for(let page=1;;page++) {
    const {users}=await get(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    for(const user of users) portfolios.push(await get('/rest/v1/rpc/export_portfolio',{owner_id:user.id}));
    if(users.length<1000)break;
  }
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await key(),nonce);
  cipher.setAAD(magic);
  const encrypted=Buffer.concat([magic,nonce,cipher.update(JSON.stringify({version:1,created_at:new Date().toISOString(),portfolios})),cipher.final(),cipher.getAuthTag()]);
  const destination=new URL(`portfolio-${new Date().toISOString().replaceAll(':','-')}.sbbackup`,directory);
  await writeFile(destination,encrypted,{mode:0o600,flag:'wx'});
  await verify(await readFile(destination));
  console.log('PASS: encrypted archive saved in .backups; plaintext was never written');
}
main().catch(error=>{console.error(`Backup failed: ${error.code ?? error.name} (private data and upstream details withheld)`);process.exitCode=1;});
