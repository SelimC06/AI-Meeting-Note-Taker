import { useCallback, useEffect, useRef, useState } from "react";
import { getJobStatus, listJobs, type JobStatus } from "../api";

export type ProcessingJob = {
  id: string;
  stage: JobStatus["stage"];
  status: JobStatus["status"];
  error: string | null;
};

const POLL_INTERVAL_MS = 1500;

// A single rejected getJobStatus (e.g. a fetch TypeError during a backend
// restart the job itself actually survives) used to be treated as fatal --
// this many CONSECUTIVE failed polls for the same job (~7.5s at the poll
// interval above) are required before it's actually declared lost, so a
// transient blip doesn't fail a job that's still running fine.
const LOST_TRACK_FAILURE_THRESHOLD = 5;

function toProcessingJob(job: JobStatus): ProcessingJob {
  return { id: job.id, stage: job.stage, status: job.status, error: job.error };
}

export function useProcessingJobs() {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const jobsRef = useRef<ProcessingJob[]>(jobs);
  jobsRef.current = jobs;
  const failureCountsRef = useRef<Map<string, number>>(new Map());
  // Only main.js's mainWindow ever receives backend:status pushes (see
  // preload.js/main.js), so this is a no-op in the rail renderer -- fine,
  // it just means the pause below never triggers there and every poll
  // failure counts normally, same as before this hook cared about it.
  const backendRestartingRef = useRef(false);

  useEffect(() => {
    const unsubscribe = window.backendAPI?.onStatus((status: BackendStatus) => {
      backendRestartingRef.current = status.state === "restarting";
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Discover jobs we don't know about yet -- e.g. one started from the
    // rail window, which runs its own instance of this hook in a separate
    // renderer process and can't update this instance's state directly.
    // Backend `listJobs()` is the shared source of truth both instances
    // poll against.
    const discoverNewJobs = async () => {
      try {
        const all = await listJobs();
        if (cancelled) return;
        const active = all
          .filter((j) => j.status === "queued" || j.status === "running")
          .map(toProcessingJob);
        setJobs((prev) => {
          const prevIds = new Set(prev.map((j) => j.id));
          const discovered = active.filter((j) => !prevIds.has(j.id));
          return discovered.length > 0 ? [...prev, ...discovered] : prev;
        });
      } catch {
        // Discovery is best-effort -- a failed listJobs() call just means
        // we try again on the next tick, same as a normal transient error.
      }
    };

    const refreshTrackedJobs = async () => {
      const active = jobsRef.current.filter(
        (j) => j.status === "queued" || j.status === "running"
      );
      if (active.length === 0) return;

      const results = await Promise.all(
        active.map(async (j) => {
          try {
            const status = await getJobStatus(j.id);
            failureCountsRef.current.delete(j.id);
            return { id: j.id, kind: "updated" as const, status };
          } catch {
            if (backendRestartingRef.current) {
              // The backend lifecycle already told us it's restarting --
              // this is an expected pause, not a real failure, so it
              // doesn't count toward the lost-track threshold at all.
              return { id: j.id, kind: "skip" as const };
            }
            const count = (failureCountsRef.current.get(j.id) ?? 0) + 1;
            if (count >= LOST_TRACK_FAILURE_THRESHOLD) {
              failureCountsRef.current.delete(j.id);
              return { id: j.id, kind: "lost" as const, lastStage: j.stage };
            }
            failureCountsRef.current.set(j.id, count);
            return { id: j.id, kind: "skip" as const };
          }
        })
      );
      if (cancelled) return;
      setJobs((prev) =>
        prev.map((j) => {
          const result = results.find((r) => r.id === j.id);
          if (!result || result.kind === "skip") return j;
          if (result.kind === "updated") return toProcessingJob(result.status);
          return {
            id: j.id,
            stage: result.lastStage,
            status: "failed",
            error:
              "Lost track of this recording — the app backend restarted while it was processing.",
          };
        })
      );
    };

    const poll = () => {
      discoverNewJobs();
      refreshTrackedJobs();
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const addJob = useCallback((jobId: string) => {
    setJobs((prev) => [...prev, { id: jobId, stage: null, status: "queued", error: null }]);
  }, []);

  const removeJob = useCallback((jobId: string) => {
    failureCountsRef.current.delete(jobId);
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  return { jobs, addJob, removeJob };
}
