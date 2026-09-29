import { buildWorkerContext } from './workerContext.js';
import { getWorkerState, setWorkerState } from '../db/d1/workerState.js';
export function createWorkerTelegramDispatcher({bot,db,handlers}){
 return async function dispatch(update){
  const fromId=update?.callback_query?.from?.id??update?.message?.from?.id;
  const scratch=fromId==null?{}:await getWorkerState(db,fromId);
  const context=buildWorkerContext({update,bot,db,userData:scratch});
  const handler=context.kind==='callback'?handlers.callback:context.kind==='media'?handlers.media:context.kind==='message'?(String(context.text).startsWith('/')?handlers.command:handlers.message):null;
  if(typeof handler!=='function')throw new Error('worker_telegram_handler_not_migrated');
  await handler(context);
  if(fromId!=null)await setWorkerState(db,fromId,context.userData);
 };
}
