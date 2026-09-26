import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,lstatSync,readlinkSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const approvedExampleDomains=new Set(['example.com','example.org','example.net','example.invalid','localhost','users.noreply.github.com']);
const allowedEmailSuffixes=['.example.invalid','.example','.test','.invalid','.localhost'];
const syntheticUsers=new Set(['operator','runner','user','test','node','ubuntu','alice','bob','foo']);
const privatePath=/(?:^|\/)(?:\.env(?:\..*)?|devices\.local\.json|credentials(?:\.[^/]*)?|initial-users\.json|seed\.json|templates\.json|template-hashes\.json|mail-defaults\.json|resource-mode\.json)$|\.(?:sqlite(?:3)?|db|pem|key|p12|pfx|jks|keystore|xlsx|xls|csv|apk|aab)$/i;
const privateDirs=/(?:^|\/)(?:\.private|private|\.openai|data|backups|outputs|playwright-report|test-results)(?:\/|$)/;
const sensitivePatterns=[
 ['password-verifier',/scrypt:[a-f0-9]{16,}:[a-f0-9]{32,}|\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}|\$argon2(?:id|i|d)\$/g],
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
 ['access-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-proj-[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g],
];
function allowedEmail(value){
 const match=value.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i);
 if(!match)return false;
 const domain=match[1].toLowerCase();
 return approvedExampleDomains.has(domain)||allowedEmailSuffixes.some(suffix=>domain.endsWith(suffix))||value==='git@github.com';
}
function textDetections(text){
 const detections=[];
 const add=(kind,index=0)=>detections.push({kind,index});
 for(const [kind,pattern] of sensitivePatterns){
  pattern.lastIndex=0;
  for(const match of text.matchAll(pattern))add(kind,match.index);
 }
 for(const match of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi))if(!allowedEmail(match[0]))add('non-example-email',match.index);
 for(const match of text.matchAll(/\/home\/([A-Za-z][A-Za-z0-9_.-]*)/g))if(!syntheticUsers.has(match[1]))add('personal-home-directory',match.index);
 return detections;
}
export function inspectPublicFile(path,text=''){
 const issues=[];
 const add=(kind,index=0)=>issues.push({path,kind,line:text.slice(0,index).split('\n').length});
 if((privatePath.test(path)&&!path.endsWith('.env.example'))||privateDirs.test(path))add('private-file-path');
 if(/(?:^|\/)(?:screenshots|design-screenshots)(?:\/|$)/.test(path)||path.startsWith('public/products/'))add('private-or-generated-asset');
 if(!/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|LICENSE[^/]*|NOTICE[^/]*)$/.test(path))for(const detection of textDetections(text))add(detection.kind,detection.index);
 return issues;
}
export function inspectCommitMessage(commit,text=''){
 const detectors=[];
 for(const {kind} of textDetections(text))if(!detectors.includes(kind))detectors.push(kind);
 return detectors;
}

const GIT_MAX_BUFFER=8*1024*1024;
class GitCheckError extends Error{constructor(kind){super(kind);this.kind=kind;}}
const git=(args,options={})=>{
 try{return execFileSync('git',args,{maxBuffer:GIT_MAX_BUFFER,stdio:['ignore','pipe','pipe'],...options});}
 catch(error){
  const code=error&&typeof error==='object'&&'code' in error?error.code:'';
  throw new GitCheckError(code==='ENOBUFS'||code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'git-output-too-large':'git-command-failed');
 }
};
function scanBlob(issues,path,data){
 if(data.includes(0))return;
 issues.push(...inspectPublicFile(path,data.toString('utf8')));
}
function checkRepositoryUnsafe(args,repository){
 const gitOptions={cwd:repository};
 const staged=args.includes('--staged');const historyIndex=args.indexOf('--history');
 const issues=[];let filesScanned=0;
 if(historyIndex>=0){
  const ref=args[historyIndex+1]||'HEAD';
  if(!/^[A-Za-z0-9_./-]+$/.test(ref)||ref.startsWith('-'))throw new GitCheckError('invalid-git-reference');
  const roots=git(['rev-list','--max-parents=0',ref],{...gitOptions,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  if(roots.length!==1||git(['log','-1','--format=%s',roots[0]],{...gitOptions,encoding:'utf8'}).trim()!=='Publish sanitized public source baseline')issues.push({path:'<history>',kind:'legacy-history',line:1});
  const metadata=git(['log','--format=%ae%n%ce',ref],{...gitOptions,encoding:'utf8'}).trim().split('\n');
  if(metadata.some(email=>!email.endsWith('@users.noreply.github.com')))issues.push({path:'<history>',kind:'non-noreply-author',line:1});
  const commits=git(['rev-list',ref],{...gitOptions,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  for(const commit of commits){
   const record=git(['show','-s','--format=%H%x00%B',commit],{...gitOptions,encoding:'utf8'}).toString();
   const separator=record.indexOf('\0');
   if(separator<0)continue;
   for(const kind of inspectCommitMessage(commit,record.slice(separator+1)))issues.push({commit,kind});
  }
  const objects=git(['rev-list','--objects',ref],{...gitOptions,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  const seen=new Set();
  for(const entry of objects){
   const space=entry.indexOf(' ');if(space<0)continue;
   const sha=entry.slice(0,space),path=entry.slice(space+1);if(seen.has(sha))continue;seen.add(sha);
   if(git(['cat-file','-t',sha],{...gitOptions,encoding:'utf8'}).trim()!=='blob')continue;
   filesScanned++;scanBlob(issues,path,git(['cat-file','blob',sha],gitOptions));
  }
 }else{
  const paths=git(['ls-files','-z'],{...gitOptions,encoding:'utf8'}).split('\0').filter(Boolean);
  for(const path of paths){
   const file=repository+'/'+path;
   if(staged){filesScanned++;scanBlob(issues,path,git(['show',`:${path}`],gitOptions));continue;}
   if(!existsSync(file))continue;
   if(lstatSync(file).isSymbolicLink()){
    const target=readlinkSync(file);if(target.startsWith('/')||target.split('/').includes('..'))issues.push({path,kind:'external-symlink',line:1});
    continue;
   }
   filesScanned++;scanBlob(issues,path,readFileSync(file));
  }
 }
 // Never print matching values, credentials or personal content into CI logs.
 console.log(JSON.stringify({status:issues.length?'FAIL':'PASS',filesScanned,issues}));
 return issues.length?1:0;
}
export function checkRepository(args=process.argv.slice(2),repository=process.cwd()){
 try{return checkRepositoryUnsafe(args,repository);}
 catch(error){
  const kind=error instanceof GitCheckError?error.kind:'git-command-failed';
  console.log(JSON.stringify({status:'FAIL',filesScanned:0,issues:[{path:args.includes('--history')?'<history>':'<repository>',kind}]}));
  return 1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=checkRepository();
