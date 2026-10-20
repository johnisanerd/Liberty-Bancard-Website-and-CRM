import {useCallback,useEffect,useRef,useState} from "react";
import {useAuth} from "./use-auth";

const KEY="sequence-create-intent:v1";
export interface SequenceCreateFields {name:string;description:string;triggerType:string}
export interface SequenceCreateIntent {
  actorId:string;accountVersion:number;commandId:string;fields:SequenceCreateFields;
  /** Recovered committed ID, once the server has answered. */
  sequenceId?:number;
}

type Principal={id?:string;accountVersion?:number}|null|undefined;
function read(user:Principal):SequenceCreateIntent|null {
  try {
    const raw=globalThis.sessionStorage?.getItem(KEY);
    if(!raw) return null;
    const value=JSON.parse(raw);
    const valid=value && typeof value.actorId==="string" && Number.isSafeInteger(value.accountVersion) && typeof value.commandId==="string" &&
      value.fields && typeof value.fields.name==="string" && typeof value.fields.description==="string" && typeof value.fields.triggerType==="string";
    // Another account's retained work is never offered to this account: quarantine = remove.
    if(!valid || !user?.id || value.actorId!==user.id || value.accountVersion!==user.accountVersion) {
      if(user?.id || !valid) globalThis.sessionStorage?.removeItem(KEY);
      return null;
    }
    return value as SequenceCreateIntent;
  } catch { return null; }
}

/** Retains the initial-create command (ID + normalized fields + recovered sequence ID) across transport failure,
 * dialog close and reload, for the current actor and account version only. Holds no credentials or step bodies. */
export function useRetainedCreateIntent() {
  const {user}=useAuth();
  const ref=useRef<SequenceCreateIntent|null>(null);
  const [intent,setIntent]=useState<SequenceCreateIntent|null>(null);
  const set=useCallback((next:SequenceCreateIntent|null)=>{
    ref.current=next;setIntent(next);
    try { if(next) globalThis.sessionStorage?.setItem(KEY,JSON.stringify(next)); else globalThis.sessionStorage?.removeItem(KEY); } catch { /* storage unavailable: in-memory retention only */ }
  },[]);
  useEffect(()=>{const stored=read(user);ref.current=stored;setIntent(stored);},[user?.id,user?.accountVersion]);
  return {
    intent,
    /** Reuses the retained command; a new one is created only when none exists for this actor/account. */
    begin(fields:SequenceCreateFields):SequenceCreateIntent {
      if(!user?.id || !Number.isSafeInteger(user.accountVersion)) throw new Error("Current account unavailable. Reload before saving.");
      if(ref.current && ref.current.actorId===user.id && ref.current.accountVersion===user.accountVersion) return ref.current;
      const next={actorId:user.id,accountVersion:user.accountVersion as number,commandId:crypto.randomUUID(),fields};
      set(next);return next;
    },
    recordCreated(sequenceId:number) {if(ref.current) set({...ref.current,sequenceId});},
    clear() {set(null);},
  };
}
