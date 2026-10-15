import { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { retainedSelection, retainedSelectionUrl } from "@/lib/crm-destination-state";

/** URL is the only retained-state store. History navigation rehydrates it. */
export function useC4RetainedSelection<T extends string>(path:string,key:string,allowed:readonly T[],
  fallback:T,legacyKey?:string) {
  const search=useSearch();
  const [,navigate]=useLocation();
  const selection=retainedSelection(search,key,allowed,fallback,legacyKey);
  const input=new URLSearchParams(search);
  const normalize=selection.issues.length===0 &&
    (input.getAll(key).length>1 || !!legacyKey&&input.has(legacyKey));
  useEffect(()=>{
    if(normalize)navigate(retainedSelectionUrl(path,search,window.location.hash,key,allowed,
      selection.value,legacyKey,false),{replace:true});
  },[normalize,path,search,key,allowed,selection.value,legacyKey,navigate]);
  return {...selection,setValue:(value:T)=>navigate(retainedSelectionUrl(path,search,
    window.location.hash,key,allowed,value,legacyKey))};
}
