import assert from 'node:assert/strict';
import {inspectCommitMessage,inspectPublicFile} from './check-public-data.mjs';
assert.equal(inspectPublicFile('src/example.ts','const contact="review@example.invalid";').length,0);
assert.equal(inspectPublicFile('.env.example','TOKEN=replace-me').length,0);
for(const path of ['resources/seed.json','resources/initial-users.json','.env.production','backup.sqlite','private/report.txt','public/products/item.png'])assert.ok(inspectPublicFile(path,'{}').length>0,path);
const address=['person','gmail.com'].join('@');
assert.ok(inspectPublicFile('src/contact.ts',address).some(x=>x.kind==='non-example-email'));
const verifier=['scrypt','a'.repeat(32),'b'.repeat(64)].join(':');
assert.ok(inspectPublicFile('src/config.ts',verifier).some(x=>x.kind==='password-verifier'));
assert.ok(inspectPublicFile('src/config.ts',['','home','personal-user','config'].join('/')).some(x=>x.kind==='personal-home-directory'));
assert.equal(inspectPublicFile('src/config.ts','/home/operator/config').length,0);
assert.deepEqual(inspectCommitMessage('0123456789abcdef','/home/operator/config'),[]);
const syntheticToken=['gh','p_','x'.repeat(30)].join('');
const syntheticVerifier=['scrypt','a'.repeat(32),'b'.repeat(64)].join(':');
const syntheticPrivateKey=['-----BEGIN ','PRIVATE KEY-----'].join('');
const syntheticEmail=['person','gmail.com'].join('@');
const syntheticHome=['/home/','private-user/fixture'].join('');
const messageDetectors=inspectCommitMessage('0123456789abcdef',[
  'benign subject',
  '',
  'large '.repeat(20000),
  syntheticToken,
  syntheticVerifier,
  syntheticPrivateKey,
  syntheticEmail,
  syntheticHome,
].join('\n'));
for(const detector of ['access-token','password-verifier','private-key','non-example-email','personal-home-directory'])assert.ok(messageDetectors.includes(detector),detector);
assert.deepEqual(inspectCommitMessage('0123456789abcdef','ordinary multiline release notes\n\noperator@example.invalid'),[]);
console.log('PASS: public-data guard positive and negative cases.');

for(const file of ['pnpm-lock.yaml','package-lock.json','LICENSE','LICENSE.txt','NOTICE','licenses/NOTICE-third-party']){
 assert.equal(inspectPublicFile(file,syntheticEmail).length,0,'maintainer email remains allowed in '+file);
 const cases=[['access-token',syntheticToken],['password-verifier',syntheticVerifier],['private-key',syntheticPrivateKey],['personal-home-directory',syntheticHome]];
 for(const [kind,value] of cases){
  const issues=inspectPublicFile(file,syntheticEmail+'\n'+value);
  assert.ok(issues.some(issue=>issue.kind===kind),file+': '+kind);
  assert.ok(!issues.some(issue=>issue.kind==='non-example-email'),file+': only email exemption applies');
  assert.ok(!JSON.stringify(issues).includes(value),'detector output must not disclose matching content');
 }
}
console.log('PASS: dependency and license email exemptions retain every sensitive-content detector.');
