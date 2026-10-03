import { getUserLanguage, checkAndIncrementQuota } from '../db/d1/users.js';
import { aiRegistryEnsure, aiRegistryGetHealthy, aiRegistryMarkSuccess, aiRegistryMarkFailure, aiUsageRecord } from '../db/d1/aiRegistry.js';
import { searchRelevantPubmed } from '../medicalSources.js';
import { request, classifyError, discoverGeminiModels, discoverGroqModels, discoverOpenrouterModels, isModelSuitableForMedbot } from '../ai/providers.js';
import { AI_DAILY_LIMIT } from '../constants.js';
import { loadWorkerSecrets } from './workerSecrets.js';

const SYSTEM_AR='أنت MEDBOT، مساعد أكاديمي طبي. أجب تعليمياً وبوضوح. لا تشخّص ولا تصف علاجاً لحالة شخصية. لا تخترع مصادر أو أرقام PMID. استخدم المصادر التي يزوّدك بها النظام فقط.';
const SYSTEM_EN='You are MEDBOT, an academic medical assistant. Answer clearly for education. Do not diagnose or prescribe for personal clinical cases. Never invent sources or PMIDs. Use only sources supplied by the system.';
const key=x=>x.provider+'|'+x.model+'|'+x.endpoint;
async function candidates(db,env){
 const persisted=await aiRegistryGetHealthy(db);
 const out=persisted.map(r=>({id:r[0],provider:r[1],model:r[2],endpoint:r[3],availability:r[4],latency_ms:r[6],success_rate:r[7]})).filter(isModelSuitableForMedbot);
 const ds=await Promise.allSettled([discoverGeminiModels(fetch,env),discoverGroqModels(fetch,env),discoverOpenrouterModels(fetch,env)]);
 for(const d of ds)if(d.status==='fulfilled')for(const item of d.value)if(isModelSuitableForMedbot(item))out.push(item);
 const map=new Map();for(const item of out)map.set(key(item),item);
 const list=[...map.values()].slice(0,12);
 for(const item of list)if(!item.id)item.id=await aiRegistryEnsure(db,item.provider,item.model,item.endpoint,'DISCOVERED',null,'text_generation');
 return list;
}
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function grounded(question,sources,lang){
 const block=sources.length?sources.map((s,i)=>'['+(i+1)+'] '+s.title+' (PMID '+s.pmid+')\n'+s.abstract).join('\n\n'):(lang==='en'?'No verified PubMed source is available. Do not cite a source.':'لا يوجد مصدر PubMed موثّق متاح. لا تذكر مصدراً.');
 return (lang==='en'?'Verified evidence':'الأدلة الموثّقة')+':\n'+block+'\n\n'+(lang==='en'?'Student question':'سؤال الطالب')+':\n'+question;
}
export async function answerWorkerAi(db,user,question,env){
 const prompt=String(question??'').trim(),uid=Number(user.id),lang=await getUserLanguage(db,uid);
 if(!prompt)return {text:lang==='en'?'Please write a clear question.':'يرجى كتابة سؤال واضح.'};
 const [allowed,remaining]=await checkAndIncrementQuota(db,uid,AI_DAILY_LIMIT);
 if(!allowed)return {text:lang==='en'?'Daily AI allowance reached.':'لقد استنفدت الحد اليومي للمساعد الذكي.',remaining:0};
 let sources=[];try{sources=await searchRelevantPubmed(prompt,3);}catch{sources=[];}
 const runtimeSecrets=await loadWorkerSecrets(db,env.MEDBOT_SECRETS_KEY,env.TELEGRAM_BOT_TOKEN).catch(()=>({}));
 const aiEnv=new Proxy(env,{get(target,prop){return Object.prototype.hasOwnProperty.call(runtimeSecrets,prop)?runtimeSecrets[prop]:target[prop];}});
 const pool=await candidates(db,aiEnv);
 if(!pool.length)return {text:lang==='en'?'The AI service is temporarily unavailable.':'المساعد الذكي غير متاح مؤقتاً.',remaining};
 for(const item of pool){
  const started=Date.now();
  try{
   const answer=await request({item,prompt:grounded(prompt,sources,lang),systemPrompt:lang==='en'?SYSTEM_EN:SYSTEM_AR,fetchImpl:fetch,env:aiEnv});
   if(!String(answer).trim())throw new Error('empty_ai_response');
   const latency=Date.now()-started;
   if(item.id){await aiRegistryMarkSuccess(db,item.id,latency);await aiUsageRecord(db,item.id,{userId:uid,latencyMs:latency,success:true});}
   const clean=String(answer).split('http').join('');
   const footer=sources.length?'\n\n<b>Sources</b>\n'+sources.map((s,i)=>(i+1)+'. <a href="https://pubmed.ncbi.nlm.nih.gov/'+s.pmid+'/">'+esc(s.title)+'</a> (PMID '+s.pmid+')').join('\n'):(lang==='en'?'\n\n<i>No relevant PubMed source was retrieved.</i>':'\n\n<i>لم يتم استرجاع مصدر PubMed مناسب لهذا السؤال.</i>');
   return {text:esc(clean)+footer,remaining};
  }catch(error){
   const [availability,auth,errorCategory]=classifyError(error);
   if(item.id){await aiRegistryMarkFailure(db,item.id,errorCategory,availability,auth);await aiUsageRecord(db,item.id,{userId:uid,latencyMs:Date.now()-started,success:false,errorCategory});}
  }
 }
 return {text:lang==='en'?'All configured AI providers failed for this request.':'تعذر الحصول على إجابة من مزودي الذكاء الاصطناعي المتاحين حالياً.',remaining};
}
