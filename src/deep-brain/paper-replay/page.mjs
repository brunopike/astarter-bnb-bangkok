import {readFile} from 'node:fs/promises';
import {featuredCase} from './replay.mjs';
import {renderPaperCase} from './view.mjs';

export async function paperPageHTML(en=true){
  const [record,css]=await Promise.all([featuredCase(),readFile(new URL('./standalone.css',import.meta.url),'utf8')]);
  return '<!doctype html><html lang="'+(en?'en':'zh-CN')+'"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deep Brain · Paper trade review</title><style>'+css+'</style><main><h1>'+(en?'Paper trade review':'模拟成交复盘')+'</h1>'+renderPaperCase(record,en)+'</main></html>';
}
