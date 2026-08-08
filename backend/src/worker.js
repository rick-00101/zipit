const jobs = require('./jobs');
const orchestrator = require('./orchestrator');
const { sleep } = require('./zerops');

const POLL_MS = Number(process.env.ZEPIT_WORKER_POLL_MS) || 2000;

// Deliberately serial: one job at a time. zcli authenticates once per machine and
// its push is not safe to run concurrently against the same credential. Throughput
// is not the constraint for a demo; a corrupted deploy in front of a judge is.
async function loop() {
  for (;;) {
    let job;
    try {
      job = await jobs.claimNext();
    } catch (err) {
      console.error('worker: claim failed', err);
      await sleep(POLL_MS);
      continue;
    }

    if (!job) {
      await sleep(POLL_MS);
      continue;
    }

    console.log(`worker: running job ${job.id} (${job.archetype})`);
    try {
      const result = await orchestrator.run(job);
      console.log(`worker: job ${job.id} live at ${result.appUrl}`);
    } catch (err) {
      // `detail` carries zcli's stdout/stderr, which is where the real cause is.
      const message = err.detail ? `${err.message}\n${err.detail}` : err.message;
      console.error(`worker: job ${job.id} failed`, message);
      await jobs.log(job.id, `FAILED: ${message.slice(0, 2000)}`);
      await jobs.finish(job.id, { status: 'failed', error: message.slice(0, 4000) });
    }
  }
}

function start() {
  loop().catch((err) => {
    console.error('worker loop died', err);
    process.exit(1);
  });
}

module.exports = { start };
