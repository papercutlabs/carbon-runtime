// Supported lifecycle discovery and explicit compaction. Neither certifies that
// a command ran nor that its additional context reached a model continuation.
import path from 'node:path';
import { HarnessFault, type Session } from './session.ts';
import { fault } from '../../lib/faults.ts';
export async function listHooks(session:Session,{cwds}:{cwds:string[]}){
 if(!Array.isArray(cwds)||!cwds.length||cwds.some(c=>!path.isAbsolute(c)))throw new HarnessFault(fault('HARNESS_HOOK_CWDS_ABSENT','hooks/list.cwds','hook discovery requires explicit absolute current working directories','pass each actual thread cwd; no session default is substituted'));
 return session.request('hooks/list',{cwds});
}
export async function compactThread(session:Session,{threadId}:{threadId:string}){
 if(typeof threadId!=='string'||!threadId)throw new HarnessFault(fault('HARNESS_COMPACT_THREAD_ABSENT','thread/compact/start.threadId','explicit loaded thread identity is required','name the existing thread; do not start or resume a replacement as a compaction substitute'));
 return session.request('thread/compact/start',{threadId});
}
