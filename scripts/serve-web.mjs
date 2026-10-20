import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { summaryApi, json, securityHeaders } from '../src/cloud/web-api.ts';
const exec = promisify(execFile);
const args = ['--profile', 'stock-tracker-deployer', '--region', 'ca-central-1', '--output', 'json', '--no-cli-pager'];
const aws = process.platform === 'win32' ? 'C:/Program Files/Amazon/AWSCLIV2/aws.exe' : 'aws';
const stack = JSON.parse((await exec(aws, ['cloudformation','describe-stacks','--stack-name','stock-tracker-9000','--query','Stacks[0].Outputs',...args])).stdout);
const table = stack.find(o => o.OutputKey === 'TableName').OutputValue;
const types = {'/':'text/html','/app.js':'text/javascript','/app.css':'text/css','/icon.svg':'image/svg+xml','/icon.png':'image/png','/sw.js':'text/javascript','/manifest.webmanifest':'application/manifest+json'};
const server = http.createServer(async (req,res) => {
  let response;
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if(path === '/api/config') response=json(200,{region:'ca-central-1',clientId:'',local:true});
    else if(path.startsWith('/api/')) response=await summaryApi({rawPath:path,headers:{authorization:'Bearer local'},requestContext:{http:{method:req.method}}},async(pk,sk)=>{
      const result=await exec(aws,['dynamodb','get-item','--table-name',table,'--key',JSON.stringify({pk:{S:pk},sk:{S:sk}}),'--consistent-read',...args],{maxBuffer:1024*1024});
      const decode = v => 'S' in v ? v.S : 'N' in v ? Number(v.N) : 'BOOL' in v ? v.BOOL : 'NULL' in v ? null : 'L' in v ? v.L.map(decode) : Object.fromEntries(Object.entries(v.M).map(([k,x])=>[k,decode(x)]));
      const item=JSON.parse(result.stdout).Item;return item?Object.fromEntries(Object.entries(item).map(([k,v])=>[k,decode(v)])):undefined;
    },async()=>true);
    else if(types[path]) response={statusCode:200,headers:{...securityHeaders,'content-type':types[path]},body:await readFile(`dist/web/web/${path==='/'?'index.html':path.slice(1)}`)};
    else response=json(404,{error:'not_found'});
  }catch{response=json(503,{error:'temporarily_unavailable'});}
  res.writeHead(response.statusCode,response.headers);res.end(response.body);
});
server.listen(4173,'127.0.0.1',()=>console.log('Local preview: http://127.0.0.1:4173 — read-only DynamoDB; no provider calls.'));
