import {readFile} from 'node:fs/promises';
import {bundledMarket,selectCase} from './replay.mjs';
import {escapeHTML,renderReceipt} from './view.mjs';

export async function paperPageHTML(en=true,{archiveFile=bundledMarket,asset}={}){
  const [raw,css]=await Promise.all([readFile(archiveFile,'utf8'),readFile(new URL('./standalone.css',import.meta.url),'utf8')]);
  const archive=JSON.parse(raw),markets=archive.assets.filter(row=>row.bars?.length>=182);
  const title=en?'Paper trade review':'模拟交易复盘';
  const options=markets.map(row=>'<option value="'+escapeHTML(row.key)+'"'+(row.key===asset?' selected':'')+'>'+escapeHTML(row.market)+'</option>').join('');
  const selected=markets.some(row=>row.key===asset);
  return '<!doctype html><html lang="'+(en?'en':'zh-CN')+'"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+
    '</title><style>'+css+'</style><main><h1>'+title+'</h1><form method="get"><input type="hidden" name="lang" value="'+(en?'en':'zh')+'"><label>'+
    (en?'Market':'市场')+' <select name="asset">'+options+'</select></label> <button type="submit">'+(en?'View receipt':'查看回执')+'</button></form>'+
    (selected?renderReceipt(selectCase(archive,{asset}),en):'')+'</main></html>';
}
