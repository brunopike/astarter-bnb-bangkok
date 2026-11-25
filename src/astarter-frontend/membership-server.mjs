import http from 'node:http';
// The historical standalone entry now joins the same origin and server ledger.
http.createServer((_req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1:4188/?page=plans','Cache-Control':'no-store'});res.end();}).listen(Number(process.env.PORT||4190),'127.0.0.1');
