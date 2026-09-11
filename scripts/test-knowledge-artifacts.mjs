import assert from 'node:assert/strict';
import { build } from 'esbuild';
const document = { id: '20000000-0000-4000-8000-000000000002', fileId: '10000000-0000-4000-8000-000000000001', status: 'ready', accessScope: 'admin', indexGeneration: 2, sourceChecksum: 'a'.repeat(64), fileVersion: 1, fileName: 'sample.pdf' };
let fixture;
globalThis.__artifactFixture = () => fixture;
const modules = {
  '@/lib/auth/session': 'export const getErpSession=()=>globalThis.__artifactFixture().session;',
  '@/lib/knowledge/repository': 'export const getKnowledgeDocument=async()=>globalThis.__artifactFixture().document; export const listActiveKnowledgeChunksForDocument=async()=>globalThis.__artifactFixture().chunks;',
  '@/lib/knowledge/markdown-artifact': 'export const readMarkdownArtifact=async()=>globalThis.__artifactFixture().markdown;',
  '@/lib/workspace-files/repository': 'export const getWorkspaceFileContent=async()=>globalThis.__artifactFixture().file; export const getWorkspaceFileIndexSource=async()=>globalThis.__artifactFixture().source;',
  '@/lib/server/cloudflare-storage': 'export const erpCloudflareBindings=async()=>({files:{get:async()=>new TextEncoder().encode(JSON.stringify({generation:2,vectors:[{id:"v2",values:[0.25]}]})).buffer}});',
};
const bundle = await build({entryPoints:['src/app/api/knowledge/documents/[id]/artifacts/route.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'fixtures',setup(b){b.onResolve({filter:/.*/},args=>modules[args.path]?{path:args.path,namespace:'fixtures'}:undefined);b.onLoad({filter:/.*/,namespace:'fixtures'},args=>({contents:modules[args.path],loader:'js'}));}}]});
const { GET } = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function reset(){ fixture={session:{user:{role:'admin'}},document:{...document},file:{},source:{checksum:document.sourceChecksum,version:1},markdown:{converter:'markitdown',generation:2,markdown:'# Safe test'},chunks:[{indexGeneration:1,indexItemId:'old',text:'old'},{indexGeneration:2,indexItemId:'v2',text:'current'}]}; }
async function call(format=''){ const url=new URL('https://erp.example/api/artifacts'+format);return GET({nextUrl:url},{params:Promise.resolve({id:document.id})}); }
reset();fixture.session=null;assert.equal((await call()).status,401);
reset();fixture.session.user.role='sales';assert.equal((await call()).status,404);
reset();fixture.file=null;assert.equal((await call()).status,404);
reset();fixture.source.version=2;assert.equal((await call()).status,409);
reset();let response=await call();assert.deepEqual((await response.json()).data.chunks.map(c=>c.id),['v2']);
reset();response=await call('?format=markdown');assert.equal(await response.text(),'# Safe test');assert.match(response.headers.get('content-disposition'),/attachment/);
reset();fixture.document.status='indexing';assert.equal((await call('?format=vectors')).status,409);
reset();response=await call('?format=vectors');assert.equal((await response.json()).vectors[0].values[0],0.25);assert.match(response.headers.get('cache-control'),/no-store/);
console.log('8 artifact authorization, freshness, generation and download checks passed.');
