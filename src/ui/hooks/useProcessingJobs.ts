import { useCallback, useEffect, useRef, useState } from "react";
import { getJobStatus, listJobs, type JobStatus } from "../api";

export type ProcessingJob = {
  id: string;
  stage: JobStatus["stage"];
  status: JobStatus["status"];
  error: string | null;
};

const POLL_INTERVAL_MS = 1500;

function toProcessingJob(job: JobStatus): ProcessingJob {
  return { id: job.id, stage: job.stage, status: job.status, error: job.error };
}

export function useProcessingJobs() {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const jobsRef = useRef<ProcessingJob[]>(jobs);
  jobsRef.current = jobs;

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

      const updates = await Promise.all(
        active.map((j) =>
          getJobStatus(j.id).catch(() => ({ lostTrackOf: j.id, lastStage: j.stage }))
        )
      );
      if (cancelled) return;
      setJobs((prev) =>
        prev.map((j) => {
          const updated = updates.find(
            (u) => "id" in u && u.id === j.id
          ) as JobStatus | undefined;
          if (updated) return toProcessingJob(updated);

          const lost = updates.find(
            (u) => "lostTrackOf" in u && u.lostTrackOf === j.id
          ) as { lostTrackOf: string; lastStage: ProcessingJob["stage"] } | undefined;
          if (lost) {
            return {
              id: j.id,
              stage: lost.lastStage,
              status: "failed",
              error:
                "Lost track of this recording — the app backend restarted while it was processing.",
            };
          }

          return j;
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
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  return { jobs, addJob, removeJob };
}
