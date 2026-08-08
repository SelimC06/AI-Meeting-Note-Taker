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
    listJobs()
      .then((all) => {
        if (cancelled) return;
        const active = all
          .filter((j) => j.status === "queued" || j.status === "running")
          .map(toProcessingJob);
        if (active.length > 0) {
          setJobs((prev) => {
            const prevIds = new Set(prev.map((j) => j.id));
            const rehydrated = active.filter((j) => !prevIds.has(j.id));
            return [...prev, ...rehydrated];
          });
        }
      })
      .catch(() => {
        // Rehydration is best-effort -- if it fails, the consumer just
        // starts with an empty job list, same as a normal cold start.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const active = jobsRef.current.filter(
        (j) => j.status === "queued" || j.status === "running"
      );
      if (active.length === 0) return;

      Promise.all(
        active.map((j) =>
          getJobStatus(j.id).catch(() => ({ lostTrackOf: j.id, lastStage: j.stage }))
        )
      ).then((updates) => {
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
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const addJob = useCallback((jobId: string) => {
    setJobs((prev) => [...prev, { id: jobId, stage: null, status: "queued", error: null }]);
  }, []);

  const removeJob = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  return { jobs, addJob, removeJob };
}
