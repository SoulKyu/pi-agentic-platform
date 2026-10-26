import { parentPort, workerData } from "node:worker_threads";
import { treeDigest } from "./image-inputs.ts";

// The bundle's digest hashes tens of thousands of files: off the daemon's event loop. One job per thread: the folder and the
// salt in `workerData`, the digest back.
const port = parentPort;
if (!port) throw new Error("digest-thread runs as a worker thread");
const job = workerData as { dir: string; format: string };
port.postMessage(treeDigest(job.dir, job.format));
