import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, XCircle, Clock, AlertCircle, RefreshCw, Terminal } from 'lucide-react';

const LogItem = ({ log }) => {
  const msgStr = String(log.msg || "");
  const isError = log.type === "error" || msgStr.includes("ERROR") || msgStr.includes("Failed") || msgStr.includes("Error");
  const isWarning = log.type === "skip" || msgStr.includes("Skipping");
  const isCompleted = log.type === "complete" || 
    msgStr.includes("Passed") || 
    msgStr.includes("Complete") || 
    msgStr.includes("successfully") || 
    msgStr.includes("Finished");
  
  let colorClass = "text-green-400";
  if (isError) colorClass = "text-red-400 font-semibold";
  else if (isWarning) colorClass = "text-yellow-400";
  else if (isCompleted) colorClass = "text-emerald-400 font-semibold";
  else if (msgStr.includes("Starting") || msgStr.includes("Processing") || msgStr.includes("Triggering") || msgStr.includes("Resuming")) {
    colorClass = "text-cyan-300";
  }

  return (
    <div className={`break-words ${colorClass} py-0.5 animate-fadeIn`}>
      <span className="opacity-50 mr-2 text-[9px] font-mono">
        {log.time ? new Date(log.time).toLocaleTimeString([], { hour12: false }) : ""}
      </span>
      {msgStr}
    </div>
  );
};

export default function Dashboard({ courseSlug, onClose }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [activeSlug, setActiveSlug] = useState(courseSlug || "default");
  
  const terminalRef = useRef(null);

  useEffect(() => {
    const findBestState = (dashboardStates, targetSlug) => {
      if (!dashboardStates || typeof dashboardStates !== "object") return null;
      if (targetSlug && targetSlug !== "default" && dashboardStates[targetSlug]) {
        return { state: dashboardStates[targetSlug], slug: targetSlug };
      }
      // If targetSlug is default or not found, pick the most active course state
      const entries = Object.entries(dashboardStates);
      if (entries.length === 0) return null;
      // Sort by latest log timestamp or start time
      entries.sort((a, b) => {
        const timeA = a[1].logs?.[a[1].logs.length - 1]?.time || a[1].startTime || 0;
        const timeB = b[1].logs?.[b[1].logs.length - 1]?.time || b[1].startTime || 0;
        return timeB - timeA;
      });
      return { state: entries[0][1], slug: entries[0][0] };
    };

    // 1. Fetch initial state from storage
    if (window.chrome && chrome.storage) {
      chrome.storage.local.get(["dashboardStates"], (res) => {
        const found = findBestState(res.dashboardStates, courseSlug);
        if (found) {
          setData(found.state);
          setActiveSlug(found.slug);
        } else {
          setData({
            courseSlug: courseSlug || "default",
            completionRate: 0,
            activeTask: { title: "Idle", timeElapsed: "00:00" },
            completedTasks: [],
            skippedTasks: [],
            errors: [],
            logs: []
          });
        }
        setLoading(false);
      });

      // 2. Listen for live runtime broadcast messages
      const messageListener = (msg) => {
        if (msg.action === "DASHBOARD_UPDATE") {
          if (!courseSlug || courseSlug === "default" || !msg.slug || msg.slug === courseSlug || msg.slug === activeSlug) {
            setData(msg.state);
            if (msg.slug) setActiveSlug(msg.slug);
            setLoading(false);
          }
        }
      };
      chrome.runtime.onMessage.addListener(messageListener);

      // 3. Listen for chrome.storage.onChanged as fallback
      const storageListener = (changes, areaName) => {
        if (areaName === "local" && changes.dashboardStates?.newValue) {
          const found = findBestState(changes.dashboardStates.newValue, courseSlug || activeSlug);
          if (found) {
            setData(found.state);
            if (found.slug) setActiveSlug(found.slug);
          }
        }
      };
      chrome.storage.onChanged.addListener(storageListener);

      return () => {
        chrome.runtime.onMessage.removeListener(messageListener);
        chrome.storage.onChanged.removeListener(storageListener);
      };
    } else {
      setLoading(false);
    }
  }, [courseSlug]);

  // Auto-scroll terminal on new logs
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [data?.logs]);

  if (error) {
    return (
      <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center text-destructive">
        <AlertCircle size={32} className="mb-2" />
        <h3 className="font-semibold text-lg">Something went wrong</h3>
        <p className="text-sm opacity-80">{error}</p>
        <button onClick={() => window.location.reload()} className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium">Try Again</button>
      </div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 20 }}
      transition={{ duration: 0.4, type: "spring", bounce: 0.2 }}
      className="absolute inset-0 z-50 bg-background/90 backdrop-blur-xl overflow-hidden p-3 flex flex-col gap-3 border-t border-border/50 origin-bottom"
    >
      <div className="flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2 overflow-hidden">
          <h2 className="text-lg font-bold tracking-tight text-foreground flex items-center gap-2 shrink-0">
            <Terminal size={18} className="text-primary" />
            Dashboard
          </h2>
          {courseSlug && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-primary/10 text-primary truncate max-w-[170px]" title={courseSlug}>
              {courseSlug}
            </span>
          )}
        </div>
        <button 
          onClick={onClose}
          className="p-1.5 rounded-full hover:bg-black/10 text-foreground transition-colors cursor-pointer"
        >
          <XCircle size={20} />
        </button>
      </div>

      {loading && !data ? (
        <div className="flex-1 flex flex-col items-center justify-center text-primary">
          <RefreshCw className="animate-spin mb-4" size={24} />
          <p className="text-xs font-medium animate-pulse">Loading metrics...</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 h-full overflow-hidden pb-4">
          
          {/* Top Stats Row */}
          <div className="grid grid-cols-4 gap-2 shrink-0">
            {/* Completion Rate */}
            <div className="col-span-2 p-3 rounded-lg bg-card border border-border shadow-sm flex flex-col items-center justify-center gap-0.5 hover:bg-primary/5 transition-colors">
              <span className="text-2xl font-bold text-primary">{data?.completionRate || 0}%</span>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Completed</span>
            </div>

            {/* Completed Count */}
            <div className="col-span-1 p-3 rounded-lg bg-card border border-border shadow-sm flex flex-col items-center justify-center gap-0.5 hover:bg-primary/5 transition-colors">
              <span className="text-xl font-bold text-primary">{data?.completedTasks?.length || 0}</span>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Done</span>
            </div>

            {/* Errors */}
            <div className="col-span-1 p-3 rounded-lg bg-destructive/10 border border-destructive/20 shadow-sm flex flex-col items-center justify-center gap-0.5 group hover:bg-destructive/20 transition-colors">
              <span className="text-xl font-bold text-destructive">{data?.errors?.length || 0}</span>
              <span className="text-[10px] font-semibold text-destructive uppercase tracking-wider">Errs</span>
            </div>
          </div>

          {/* Active Task */}
          <div className="p-3 rounded-lg bg-card border border-border shadow-sm flex flex-col gap-1 relative overflow-hidden group shrink-0">
            <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="flex items-center justify-between text-primary font-semibold text-[10px] uppercase tracking-wider">
              <div className="flex items-center gap-1.5">
                <Clock size={12} className="animate-pulse" />
                On Task Right Now
              </div>
              <span className="text-muted-foreground">{data?.activeTask?.timeElapsed || "00:00"}</span>
            </div>
            {/* Extremely prominent exact task name */}
            <p className="text-sm font-bold text-card-foreground leading-snug line-clamp-2">
              {(data?.activeTask?.title || "Idle").replace(/Processing item: |Triggering quiz solver for |Starting run for course: /, '')}
            </p>
          </div>

          {/* High Speed Terminal Feed */}
          <div className="flex-1 min-h-0 p-3 rounded-lg bg-black/90 dark:bg-black/80 border border-border shadow-inner flex flex-col gap-2 relative">
            <div className="absolute top-0 left-0 w-full h-4 bg-gradient-to-b from-black/90 to-transparent pointer-events-none z-10 rounded-t-lg" />
            <h4 className="text-[10px] font-bold text-primary/70 uppercase tracking-widest absolute top-2 right-3 z-20">Live Feed</h4>
            
            <div 
              ref={terminalRef}
              className="flex-1 overflow-y-auto space-y-1.5 pr-2 pt-4 pb-2 font-mono text-[11px] leading-tight text-green-400 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent"
            >
              {(!data?.logs || data.logs.length === 0) ? (
                <div className="text-muted-foreground/50 text-xs text-center mt-2 font-mono">Waiting for solver stream...</div>
              ) : (
                data.logs.map((log, i) => (
                  <LogItem key={log.time + '-' + i} log={log} />
                ))
              )}
            </div>
          </div>
          
        </div>
      )}
    </motion.div>
  );
}
