import { parentPort, workerData } from "node:worker_threads";
import { type ProfileJob, runProfileJob } from "./profile-job.ts";

// I4: the profile preparation, off the daemon's event loop. One job per thread: the job in `workerData`, the outcome back.
const port = parentPort;
if (!port) throw new Error("profile-thread runs as a worker thread");
port.postMessage(runProfileJob(workerData as ProfileJob));
