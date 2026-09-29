import { getWorkerState, setWorkerState } from '../db/d1/workerState.js';
import { buildWorkerContext } from './workerContext.js';
export function createWorkerTelegramDispatcher({bot,db,handlers,userData=new Map()}){
 return async function dispatch(update){
  const fromId=update?.callback_query?.from?.id??update?.message?.from?.id;
  const scratch=fromId==null?{}:(db&&typeof db.prepare==='function'?await getWorkerState(db,fromId):(userData.get(fromId)??{}));
  const context=buildWorkerContext({update,bot,db,userData:scratch});
  const handler=context.kind==='callback'?handlers.callback:context.kind==='media'?handlers.media:context.kind==='message'?(String(context.text).startsWith('/')?handlers.command:handlers.message):null;
  if(typeof handler!=='function')throw new Error('worker_telegram_handler_not_migrated');
  await handler(context);
  if(fromId!=null){if(db&&typeof db.prepare==='function')await setWorkerState(db,fromId,context.userData);else userData.set(fromId,context.userData);}
 };
}
