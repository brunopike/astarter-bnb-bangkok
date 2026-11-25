// Local SQLite-backed services require a durable authenticated backend before cloud enablement.
export default function handler(req,res){
  const url=new URL(req.url,'https://astarter.imstark.site');
  const raw=url.searchParams.get('selection_version');
  const selection=raw&&/^(0|[1-9]\d{0,9})$/.test(raw)&&Number(raw)<=2147483647?Number(raw):0;
  res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Retry-After':'60'});
  res.end(JSON.stringify({error:'service-unavailable',schema_version:'AstarterPublicDataError.v1',code:'DATA_SERVICE_UNAVAILABLE',request_id:crypto.randomUUID(),selection_version:selection,message:'The cloud backend for this feature is not connected.',retryable:true,mode:'simulation-only',real_trading_connected:false}));
}
