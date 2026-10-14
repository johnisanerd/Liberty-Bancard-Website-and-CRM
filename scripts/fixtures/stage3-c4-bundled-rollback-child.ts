import path from "node:path";
import {pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount,
  installCertificationLocalAiConstructorEnvironment} from "../certification-provider-deny";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";

applyCertificationProviderDenyBoundary({fatal:true});
installCertificationLocalAiConstructorEnvironment();
process.env.TEST_REDIS_PREFIX+=`bundled_rollback_${randomUUID().replaceAll("-","")}_`;
await assertDisposableTestInfrastructure({operation:"C4 owned bundled rollback",requireRedis:true,reserveRedisNamespace:true});
if(process.env.NODE_ENV!=="test"||process.env.BACKGROUND_JOB_PROFILE!=="off")
  throw new Error("Bundled rehearsal requires test runtime and disabled background profile");
const watchdog=setInterval(()=>{
  if(getBlockedCertificationNetworkAttemptCount()>0)process.exit(70);
},100);watchdog.unref();
const bundle=path.resolve(process.argv[2]);
if(path.basename(bundle)!=="index.cjs"||path.basename(path.dirname(bundle))!=="dist")
  throw new Error("Expected verified production bundle");
await import(pathToFileURL(bundle).href);
