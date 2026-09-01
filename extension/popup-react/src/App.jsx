import React, { useState, useEffect } from 'react';
import { Settings2, KeyRound, Sparkles, BrainCircuit, Palette, Atom, Pin, FastForward, GraduationCap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from './components/Button';
import { AuthorCard } from './components/AuthorCard';
import PetCat from './components/PetCat';
import Dashboard from './components/Dashboard';

const modelOptions = {
  nvidia: [
    "meta/llama-3.3-70b-instruct",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "deepseek-ai/deepseek-v3",
    "deepseek-ai/deepseek-r1",
    "mistralai/mistral-large-2-instruct",
    "meta/llama-3.1-8b-instruct"
  ],
  openai: [
    "gpt-4o-mini",
    "gpt-4o",
    "o3-mini",
    "o1-mini"
  ],
  anthropic: [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-7-sonnet-20250219"
  ],
  gemini: [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-2.0-flash-lite"
  ]
};

const defaultModels = {
  nvidia: "meta/llama-3.3-70b-instruct",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-20241022",
  gemini: "gemini-2.0-flash"
};

export default function App() {
  const [provider, setProvider] = useState('nvidia');
  const [modelName, setModelName] = useState(defaultModels.nvidia);
  const [apiKey, setApiKey] = useState('');
  const [solveMode, setSolveMode] = useState('full'); // 'full' | 'graded' | 'videos'
  const [skipPractice, setSkipPractice] = useState(true);
  const [targetGrade, setTargetGrade] = useState(80); // percent
  const [status, setStatus] = useState({ text: 'Ready', state: 'idle' });
  const [theme, setTheme] = useState('theme-earth'); // Default theme
  const [showDashboard, setShowDashboard] = useState(false);
  const [completionRate, setCompletionRate] = useState(0);
  const [courseSlug, setCourseSlug] = useState('');
  const [hoveredBtn, setHoveredBtn] = useState(null);

  const hasKey = apiKey.trim().length > 0;
  const isStickyMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('sticky') === 'true';

  useEffect(() => {
    // Apply theme to document html element so CSS variables propagate correctly
    document.documentElement.className = theme;
  }, [theme]);

  const openStickyMode = () => {
    if (isStickyMode) return;
    if (window.chrome && chrome.windows) {
      chrome.windows.create({
        url: chrome.runtime.getURL("popup/index.html?sticky=true"),
        type: "popup",
        width: 440,
        height: 640,
        top: 80,
        left: (window.screen.availWidth || 1200) - 460,
        focused: true
      }, () => {
        window.close();
      });
    } else {
      window.open(window.location.href + "?sticky=true", "skipera_sticky", "width=440,height=640");
    }
  };

  // 1. Detect current course from active tab (works in popup and sticky mode)
  useEffect(() => {
    if (window.chrome && chrome.tabs) {
      const detectSlug = async () => {
        try {
          // Check coursera tabs across windows first
          const courseraTabs = await chrome.tabs.query({ url: "*://*.coursera.org/*" });
          const targetTab = courseraTabs?.find(t => t.active) || courseraTabs?.[0];
          if (targetTab?.url) {
            const urlObj = new URL(targetTab.url);
            const urlParts = urlObj.pathname.split('/');
            const learnIdx = urlParts.indexOf('learn');
            if (learnIdx !== -1 && urlParts[learnIdx + 1]) {
              setCourseSlug(urlParts[learnIdx + 1]);
              return;
            }
          }
          
          // Fallback to active tab in current window
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.url) {
            const urlObj = new URL(tab.url);
            const urlParts = urlObj.pathname.split('/');
            const learnIdx = urlParts.indexOf('learn');
            if (learnIdx !== -1 && urlParts[learnIdx + 1]) {
              setCourseSlug(urlParts[learnIdx + 1]);
            }
          }
        } catch (e) {
          console.warn("Could not detect course tab", e);
        }
      };

      detectSlug();
      const tabActivatedListener = () => detectSlug();
      chrome.tabs.onActivated?.addListener(tabActivatedListener);
      return () => chrome.tabs.onActivated?.removeListener(tabActivatedListener);
    }
  }, []);

  // 2. Load settings and course-specific completion rate
  useEffect(() => {
    if (window.chrome && chrome.storage) {
      chrome.storage.local.get(['apiKey', 'provider', 'modelName', 'theme', 'dashboardStates', 'skipPractice', 'solveMode', 'targetGrade'], (result) => {
        if (result.apiKey) setApiKey(result.apiKey);
        if (result.theme) setTheme(result.theme);
        if (result.skipPractice !== undefined) setSkipPractice(result.skipPractice);
        if (result.solveMode) setSolveMode(result.solveMode);
        if (typeof result.targetGrade === 'number') setTargetGrade(result.targetGrade);
        if (result.provider) {
          setProvider(result.provider);
          const validList = modelOptions[result.provider] || [];
          const effective = result.modelName && validList.includes(result.modelName)
            ? result.modelName
            : defaultModels[result.provider];
          setModelName(effective);
        }
        if (courseSlug && result.dashboardStates?.[courseSlug]) {
          setCompletionRate(result.dashboardStates[courseSlug].completionRate || 0);
        } else if (!courseSlug) {
          setCompletionRate(0);
        }
      });

      const messageListener = (msg) => {
        if (msg.action === "DASHBOARD_UPDATE") {
          const currentSlug = courseSlug || "default";
          if (!msg.slug || msg.slug === currentSlug) {
            setCompletionRate(msg.state?.completionRate || 0);
          }
        }
      };
      chrome.runtime.onMessage.addListener(messageListener);
      return () => chrome.runtime.onMessage.removeListener(messageListener);
    }
  }, [courseSlug]);

  useEffect(() => {
    if (window.chrome && chrome.storage) {
      chrome.storage.local.set({ apiKey, provider, modelName, theme, skipPractice, solveMode, targetGrade });
    }
  }, [apiKey, provider, modelName, theme, skipPractice, solveMode, targetGrade]);

  const handleProviderChange = (e) => {
    const newProv = e.target.value;
    setProvider(newProv);
    setModelName(defaultModels[newProv] || modelOptions[newProv][0]);
  };

  const themes = ['theme-earth', 'theme-fire', 'theme-sage'];

  const toggleTheme = (e) => {
    const nextThemeIndex = (themes.indexOf(theme) + 1) % themes.length;
    const nextTheme = themes[nextThemeIndex];

    if (!document.startViewTransition) {
      document.documentElement.className = nextTheme;
      setTheme(nextTheme);
      return;
    }

    const x = e?.clientX ?? window.innerWidth - 30;
    const y = e?.clientY ?? 30;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    const transition = document.startViewTransition(() => {
      document.documentElement.className = nextTheme;
      setTheme(nextTheme);
    });

    transition.ready.then(() => {
      if (nextTheme === 'theme-fire') {
        document.documentElement.animate(
          {
            filter: ['blur(0px)', 'blur(12px)'],
            opacity: [1, 0],
            transform: ['scale(1)', 'scale(0.92)']
          },
          { duration: 600, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', pseudoElement: '::view-transition-old(root)' }
        );
        document.documentElement.animate(
          {
            filter: ['blur(12px)', 'blur(0px)'],
            opacity: [0, 1],
            transform: ['scale(1.08)', 'scale(1)']
          },
          { duration: 600, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', pseudoElement: '::view-transition-new(root)' }
        );
      } else if (nextTheme === 'theme-sage') {
        document.documentElement.animate(
          {
            opacity: [1, 0],
            transform: ['translateX(0px)', 'translateX(-30px)']
          },
          { duration: 500, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', pseudoElement: '::view-transition-old(root)' }
        );
        document.documentElement.animate(
          {
            opacity: [0, 1],
            transform: ['translateX(30px)', 'translateX(0px)']
          },
          { duration: 500, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', pseudoElement: '::view-transition-new(root)' }
        );
      } else {
        document.documentElement.animate(
          {
            opacity: [1, 0],
            transform: ['scale(1)', 'scale(0.96)']
          },
          { duration: 550, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', pseudoElement: '::view-transition-old(root)' }
        );
        document.documentElement.animate(
          {
            opacity: [0, 1],
            transform: ['translateY(24px) scale(0.98)', 'translateY(0px) scale(1)']
          },
          { duration: 550, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', pseudoElement: '::view-transition-new(root)' }
        );
      }
    });
  };

  const getHeroConfig = () => {
    if (!hasKey) {
      return {
        action: 'START_VIDEOS_ONLY',
        title: 'Fast-Forward Videos & Readings',
        badge: 'No Key Needed',
        icon: <FastForward size={16} />,
        subtitle: 'Auto-completes lectures and readings instantly',
        variant: 'primary'
      };
    }

    if (solveMode === 'graded') {
      return {
        action: 'START_GRADED_ONLY',
        title: 'Auto-Solve Graded Items',
        badge: 'Graded Only',
        icon: <GraduationCap size={16} />,
        subtitle: 'Skips videos and solves graded quizzes with AI',
        variant: 'primary'
      };
    }

    if (solveMode === 'videos') {
      return {
        action: 'START_VIDEOS_ONLY',
        title: 'Fast-Forward Videos & Readings',
        badge: 'Fast-Forward',
        icon: <FastForward size={16} />,
        subtitle: 'Bypasses video and reading material only',
        variant: 'secondary'
      };
    }

    // Default: Full course
    return {
      action: 'START_FULL_COURSE_SOLVER',
      title: 'Auto-Solve Entire Course',
      badge: 'Full Auto (AI)',
      icon: <Sparkles size={16} className="text-amber-300 animate-pulse" />,
      subtitle: 'Fast-forwards videos & answers quizzes with AI',
      variant: 'primary'
    };
  };

  const heroConfig = getHeroConfig();

  const handleHeroClick = () => {
    executeSolver(heroConfig.action);
  };

  const executeSolver = async (action) => {
    const isVideosOnly = action === 'START_VIDEOS_ONLY' || !apiKey.trim();
    const isGradedOnlyAction = action === 'START_GRADED_ONLY' || solveMode === 'graded';
    
    if (action === 'START_FULL_COURSE_SOLVER' && !apiKey.trim()) {
      setStatus({ text: "No API Key: Running Videos & Readings only", state: "working" });
    } else if (action === 'START_VIDEOS_ONLY') {
      setStatus({ text: "Fast-forwarding videos & readings...", state: "working" });
    } else if (action === 'START_GRADED_ONLY' || isGradedOnlyAction) {
      if (!apiKey.trim()) {
        setStatus({ text: "Error: API Key required for AI quiz solver", state: "error" });
        return;
      }
      setStatus({ text: "Solving graded assessments only...", state: "working" });
    } else if (!apiKey.trim()) {
      setStatus({ text: "Error: API Key required for AI quiz solver", state: "error" });
      return;
    }
    
    setShowDashboard(true);
    
    if (window.chrome && chrome.tabs) {
      try {
        let targetTab = null;
        
        // Find Coursera tab (active one preferred, cross-window compatible for sticky mode)
        const courseraTabs = await chrome.tabs.query({ url: "*://*.coursera.org/*" });
        if (courseraTabs && courseraTabs.length > 0) {
          targetTab = courseraTabs.find(t => t.active) || courseraTabs[0];
        } else {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTab = tab;
        }

        if (!targetTab || !targetTab.url || !targetTab.url.includes("coursera.org")) {
          setStatus({ text: "Error: Must have an open Coursera tab", state: "error" });
          return;
        }

        const response = await chrome.tabs.sendMessage(targetTab.id, {
          action: action,
          settings: {
            apiKey,
            provider,
            modelName,
            videosOnly: isVideosOnly,
            gradedOnly: isGradedOnlyAction,
            skipPractice: skipPractice,
            targetGrade: targetGrade / 100
          }
        });
        
        if (response?.error || response?.status === "Error" || response?.status?.startsWith("Error")) {
          setStatus({ text: response?.error || response?.status, state: "error" });
        } else {
          setStatus({ 
            text: isVideosOnly ? "Fast-forwarding videos & readings..." : (response?.status || "Solver running..."), 
            state: "working" 
          });
        }
      } catch (err) {
        setStatus({ text: "Error: Reload the Coursera page", state: "error" });
      }
    } else {
      // Mock for dev
      setTimeout(() => setStatus({ text: "Completed successfully", state: "idle" }), 2000);
    }
  };

  const [mouseTrail, setMouseTrail] = useState({ x: -100, y: -100 });

  const handlePointerMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMouseTrail({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
  };

  return (
    <div 
      onPointerMove={handlePointerMove}
      className="flex flex-col min-h-screen relative overflow-hidden p-4 md:p-8 w-full max-w-5xl mx-auto select-none group"
    >
      {/* Dynamic Cursor Illumination Spotlight & Laser Glow */}
      <div 
        className="pointer-events-none absolute -inset-px transition-opacity duration-300 opacity-70"
        style={{
          background: `radial-gradient(400px circle at ${mouseTrail.x}px ${mouseTrail.y}px, var(--color-primary) 0%, transparent 80%)`,
          opacity: 0.12,
          mixBlendMode: 'screen'
        }}
      />
      <div 
        className="pointer-events-none absolute w-3 h-3 rounded-full bg-primary/40 blur-[2px] transition-transform duration-75 ease-out"
        style={{
          transform: `translate3d(${mouseTrail.x - 6}px, ${mouseTrail.y - 6}px, 0)`,
          boxShadow: '0 0 12px var(--color-primary)'
        }}
      />

      {/* Dashboard Overlay */}
      <AnimatePresence>
        {showDashboard && (
          <Dashboard courseSlug={courseSlug} onClose={() => setShowDashboard(false)} />
        )}
      </AnimatePresence>

      <PetCat />
      {/* Soft background blobs */}
      <div className="absolute top-[-20%] left-[-20%] w-[60%] h-[50%] bg-accent rounded-full blur-[60px] opacity-40 mix-blend-multiply pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[70%] h-[60%] bg-primary rounded-full blur-[80px] opacity-10 mix-blend-multiply pointer-events-none" />

      <div className="relative z-10 flex flex-col flex-1 mt-2">
        
        {/* Header */}
        <header className="flex items-center justify-between md:col-span-12 mb-3 md:mb-6">
          <motion.div 
            className="flex items-center gap-3"
            initial={{ y: -10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5, type: "spring" }}
          >
            {/* Interactive Logo */}
            <motion.div 
              className="w-11 h-11 bg-primary/10 text-primary rounded-xl flex items-center justify-center cursor-pointer shadow-sm border border-primary/15"
              whileHover={{ scale: 1.15, rotate: 180, transition: { type: "spring", stiffness: 400, damping: 10 } }}
              whileTap={{ scale: 0.85, rotate: -180 }}
            >
              <motion.div whileHover={{ scale: 1.2 }}>
                <Atom size={24} strokeWidth={2.5} />
              </motion.div>
            </motion.div>
            <div className="flex flex-col">
              <h1 className="text-2xl font-extrabold tracking-tight text-primary leading-none">Skipera</h1>
              <span className="text-[10.5px] font-semibold text-muted-foreground uppercase tracking-wider mt-0.5">Next-Gen Solver</span>
            </div>
          </motion.div>

          {/* Action Buttons Toolbar with Dynamic Hover Tooltips */}
          <div className="flex items-center gap-2.5">
            
            {/* 1. Pin / Stick Me Button */}
            <div className="relative flex flex-col items-center">
              <motion.button 
                onClick={openStickyMode}
                onMouseEnter={() => setHoveredBtn('pin')}
                onMouseLeave={() => setHoveredBtn(null)}
                whileHover={{ scale: 1.15, rotate: isStickyMode ? 0 : 25, transition: { type: "spring", stiffness: 400, damping: 12 } }}
                whileTap={{ scale: 0.85, rotate: -30 }}
                className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all cursor-pointer shadow-sm border ${
                  isStickyMode 
                    ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/30" 
                    : "bg-primary/10 hover:bg-primary/20 text-primary border-primary/15 hover:border-primary/30"
                }`}
                aria-label="Pin window"
              >
                <Pin size={22} strokeWidth={2.2} className={isStickyMode ? "fill-current" : ""} />
              </motion.button>
              
              <AnimatePresence>
                {hoveredBtn === 'pin' && (
                  <motion.div 
                    initial={{ opacity: 0, y: 6, scale: 0.85 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.85 }}
                    transition={{ duration: 0.15 }}
                    className="absolute top-13 px-2.5 py-1 rounded-lg bg-card/95 text-foreground border border-border shadow-xl text-[11px] font-bold whitespace-nowrap pointer-events-none z-50 backdrop-blur-md"
                  >
                    {isStickyMode ? "Pinned 🧲📌" : "Stick Me !! 🧲📌"}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* 2. Completion Percentage / Dashboard Button */}
            {/* 2. Completion Percentage / Dashboard Button */}
            <div className="relative flex flex-col items-center">
              <motion.button 
                onClick={() => setShowDashboard(true)}
                onMouseEnter={() => setHoveredBtn('dashboard')}
                onMouseLeave={() => setHoveredBtn(null)}
                whileHover={{ scale: 1.15, rotate: 12, transition: { type: "spring", stiffness: 400, damping: 12 } }}
                whileTap={{ scale: 0.85, rotate: -15 }}
                className="w-11 h-11 rounded-xl bg-primary/10 hover:bg-primary/20 text-primary flex items-center justify-center transition-all cursor-pointer relative shadow-sm border border-primary/15 hover:border-primary/30"
                aria-label="View Dashboard"
              >
                <svg className="w-9 h-9 transform -rotate-90 absolute inset-0 m-auto" viewBox="0 0 36 36">
                  <circle cx="18" cy="18" r="15" fill="none" className="stroke-primary/20" strokeWidth="3" />
                  <circle 
                    cx="18" cy="18" r="15" 
                    fill="none" 
                    className="stroke-primary transition-all duration-500 ease-out" 
                    strokeWidth="3" 
                    strokeDasharray="94.25" 
                    strokeDashoffset={94.25 - (94.25 * completionRate) / 100} 
                    strokeLinecap="round" 
                  />
                </svg>
                <span className="text-[10px] font-extrabold z-10 select-none">{completionRate}%</span>
              </motion.button>
              
              <AnimatePresence>
                {hoveredBtn === 'dashboard' && (
                  <motion.div 
                    initial={{ opacity: 0, y: 6, scale: 0.85 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.85 }}
                    transition={{ duration: 0.15 }}
                    className="absolute top-13 px-2.5 py-1 rounded-lg bg-card/95 text-foreground border border-border shadow-xl text-[11px] font-bold whitespace-nowrap pointer-events-none z-50 backdrop-blur-md"
                  >
                    Dashboard 📊
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* 3. Theme Toggle Button */}
            <div className="relative flex flex-col items-center">
              <motion.button 
                onClick={toggleTheme}
                onMouseEnter={() => setHoveredBtn('theme')}
                onMouseLeave={() => setHoveredBtn(null)}
                whileHover={{ scale: 1.15, rotate: 90, transition: { type: "spring", stiffness: 400, damping: 12 } }}
                whileTap={{ scale: 0.85, rotate: 270 }}
                className="w-11 h-11 rounded-xl bg-primary/10 hover:bg-primary/20 text-primary flex items-center justify-center transition-all cursor-pointer shadow-sm border border-primary/15 hover:border-primary/30"
                aria-label="Toggle Theme"
              >
                <Palette size={22} strokeWidth={2.2} />
              </motion.button>
              
              <AnimatePresence>
                {hoveredBtn === 'theme' && (
                  <motion.div 
                    initial={{ opacity: 0, y: 6, scale: 0.85 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.85 }}
                    transition={{ duration: 0.15 }}
                    className="absolute top-13 px-2.5 py-1 rounded-lg bg-card/95 text-foreground border border-border shadow-xl text-[11px] font-bold whitespace-nowrap pointer-events-none z-50 backdrop-blur-md"
                  >
                    Theme 🎨
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

        </div>
      </header>

      {/* Responsive Content Grid */}
      <main className="grid grid-cols-1 md:grid-cols-12 gap-4 flex-1 items-start mt-4 pb-4">
        
        {/* Form Container */}
        <div className="flex flex-col gap-4 bg-card backdrop-blur-xl rounded-2xl p-5 md:p-6 border border-border shadow-sm flex-1 md:col-span-7 lg:col-span-8 h-full">
          
          {/* Provider Select */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10.5px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5 ml-0.5">
              <BrainCircuit size={13} /> Provider
            </label>
            <div className="relative">
              <select 
                className="w-full appearance-none bg-background/50 border border-input text-foreground text-[12.5px] font-medium rounded-xl px-3 py-2.5 outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 transition-all shadow-sm"
                value={provider}
                onChange={handleProviderChange}
              >
                <option value="nvidia">NVIDIA NIM (Recommended)</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Google Gemini</option>
              </select>
            </div>
          </div>

          {/* Model Select */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10.5px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5 ml-0.5">
              <Settings2 size={13} /> Architecture
            </label>
            <div className="relative">
              <select 
                className="w-full appearance-none bg-background/50 border border-input text-foreground text-[12.5px] font-medium rounded-xl px-3 py-2.5 outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 transition-all shadow-sm"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
              >
                {modelOptions[provider]?.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          </div>

          {/* API Key Input with Cool Dynamic Unlocking Animation */}
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between items-center">
              <label className="text-[10.5px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5 ml-0.5">
                <KeyRound size={13} /> API Key
              </label>
              <AnimatePresence mode="wait">
                {hasKey ? (
                  <motion.span
                    key="ai-unlocked"
                    initial={{ opacity: 0, scale: 0.7, y: -2 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.7 }}
                    transition={{ type: "spring", stiffness: 500, damping: 20 }}
                    className="text-[9.5px] font-extrabold text-primary flex items-center gap-1 bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/25 shadow-xs"
                  >
                    <Sparkles size={11} className="text-primary animate-pulse" />
                    AI Powerhouse Unlocked
                  </motion.span>
                ) : (
                  <motion.span
                    key="videos-mode"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-[9px] font-medium text-muted-foreground/70 lowercase tracking-normal"
                  >
                    (optional for fast-forward)
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <div className="relative">
              <motion.div
                animate={{
                  boxShadow: hasKey 
                    ? "0 0 15px -3px var(--color-primary, rgba(99, 102, 241, 0.2))" 
                    : "none"
                }}
                className="rounded-xl transition-all"
              >
                <textarea 
                  rows={2}
                  className={`w-full bg-background/50 border ${
                    hasKey ? 'border-primary/50 text-foreground ring-1 ring-primary/25' : 'border-input text-foreground'
                  } text-[11.5px] font-mono rounded-xl px-3 py-2.5 outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 transition-all shadow-sm resize-none`}
                  placeholder="nvapi-... or sk-... (Leave blank for Fast-Forward only)"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </motion.div>
              <AnimatePresence>
                {hasKey && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0 }} 
                    animate={{ opacity: 1, scale: 1 }} 
                    exit={{ opacity: 0, scale: 0 }}
                    className="absolute top-2.5 right-2.5 pointer-events-none flex items-center gap-1 bg-background/85 backdrop-blur-xs px-1.5 py-0.5 rounded-md border border-border"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[8.5px] font-bold text-muted-foreground uppercase tracking-wider">Active</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Assessment Preferences */}
          <div className="flex flex-col gap-2 pt-1 border-t border-border/50">
            <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5 ml-0.5">
              <GraduationCap size={13} /> Preferences
            </label>
            <div>
              {/* Skip Practice Toggle */}
              <label className="flex items-center justify-between p-2.5 rounded-xl bg-background/40 border border-input/60 hover:border-primary/30 transition-all cursor-pointer select-none">
                <div className="flex flex-col pr-2">
                  <span className="text-[11.5px] font-semibold text-foreground flex items-center gap-1.5">
                    Skip Practice Quizzes
                  </span>
                  <span className="text-[9.5px] text-muted-foreground">
                    Only solve graded assessments, skip formative practice exercises
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={skipPractice}
                  onChange={(e) => setSkipPractice(e.target.checked)}
                  className="w-4 h-4 rounded border-input text-primary focus:ring-primary/20 accent-primary cursor-pointer"
                />
              </label>

              {/* Target Grade */}
              <div className="mt-2 p-2.5 rounded-xl bg-background/40 border border-input/60">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11.5px] font-semibold text-foreground">Target Grade</span>
                  <span className="text-[11.5px] font-bold text-primary tabular-nums">{targetGrade}%</span>
                </div>
                <input
                  type="range"
                  min="50" max="100" step="5"
                  value={targetGrade}
                  onChange={(e) => setTargetGrade(Number(e.target.value))}
                  className="w-full accent-primary cursor-pointer"
                />
                <span className="text-[9.5px] text-muted-foreground">Retry graded quizzes until they hit this score (max 3 attempts)</span>
              </div>
            </div>
          </div>

        </div>

        {/* Actions & Status Container */}
        <div className="flex flex-col gap-4 md:col-span-5 lg:col-span-4 h-full">
          
          {/* Main Action Card */}
          <div className="flex flex-col gap-3.5 bg-card/60 backdrop-blur-xl rounded-2xl p-4 sm:p-5 border border-border shadow-sm">
            
            {/* Mode Segmented Control */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center px-0.5">
                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                  Run Mode
                </label>
                {!hasKey && (
                  <span className="text-[9px] text-amber-500 font-semibold lowercase">
                    Key unlocks AI
                  </span>
                )}
              </div>

              <div className="grid grid-cols-3 p-1 bg-background/60 backdrop-blur-md rounded-xl border border-input/60 gap-1 relative">
                {[
                  { id: 'full', label: 'Full Course', icon: <Sparkles size={12} />, requiresKey: true },
                  { id: 'graded', label: 'Graded Only', icon: <GraduationCap size={12} />, requiresKey: true },
                  { id: 'videos', label: 'Fast-Forward', icon: <FastForward size={12} />, requiresKey: false }
                ].map((mode) => {
                  const isSelected = solveMode === mode.id;
                  const isLocked = mode.requiresKey && !hasKey;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => setSolveMode(mode.id)}
                      className={`relative z-10 flex flex-col items-center justify-center gap-1 py-1.5 px-1 rounded-lg text-[10px] font-bold transition-all cursor-pointer ${
                        isSelected 
                          ? 'text-primary-foreground' 
                          : isLocked 
                            ? 'text-muted-foreground/60 hover:text-muted-foreground' 
                            : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {isSelected && (
                        <motion.div
                          layoutId="activePill"
                          className="absolute inset-0 bg-primary rounded-lg shadow-sm -z-10"
                          transition={{ type: "spring", stiffness: 450, damping: 35 }}
                        />
                      )}
                      <span className="flex items-center gap-1">
                        {mode.icon}
                        <span>{mode.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Single Smart Hero Action Button */}
            <motion.div
              key={`${solveMode}-${hasKey}`}
              initial={{ scale: 0.98, opacity: 0.8 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="pt-1"
            >
              <Button 
                variant={heroConfig.variant} 
                onClick={handleHeroClick}
                icon={heroConfig.icon}
              >
                <div className="flex items-center justify-between w-full">
                  <div className="flex flex-col text-left">
                    <span className="font-bold text-[12.5px] leading-tight">{heroConfig.title}</span>
                    <span className="text-[9px] font-normal text-primary-foreground/75 leading-tight mt-0.5">
                      {heroConfig.subtitle}
                    </span>
                  </div>
                  <span className="text-[8.5px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-primary-foreground/20 text-primary-foreground tracking-wider ml-2 shrink-0">
                    {heroConfig.badge}
                  </span>
                </div>
              </Button>
            </motion.div>

          </div>

          {/* Status Indicator */}
          <AnimatePresence>
            {status.state !== 'idle' && (
              <motion.div 
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: 'auto', marginTop: 8 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2.5 bg-card border border-border rounded-lg px-3 py-2 text-[11.5px] font-medium text-foreground shadow-sm">
                  <div className="relative flex items-center justify-center shrink-0">
                    <div className={`w-2 h-2 rounded-full ${status.state === 'error' ? 'bg-destructive' : 'bg-primary'}`} />
                    {status.state === 'working' && (
                      <motion.div 
                        className="absolute inset-0 rounded-full bg-primary"
                        animate={{ scale: [1, 2.5], opacity: [0.5, 0] }}
                        transition={{ duration: 1.2, repeat: Infinity, ease: "easeOut" }}
                      />
                    )}
                  </div>
                  <span className="truncate">{status.text}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      </main>

      {/* Footer Authors */}
      <footer className="mt-auto sticky bottom-0 z-30 pb-4 pt-4 bg-background/90 backdrop-blur-md">
        <div className="text-[9px] font-bold text-muted-foreground/60 uppercase tracking-widest text-center mb-2">Created By</div>
        <div className="grid grid-cols-2 gap-2">
          <AuthorCard name="serv0id" role="Original Creator" username="serv0id" />
          <AuthorCard name="Mrityunjay" role="Extension & Engine" username="yamantaka-singh" />
        </div>
      </footer>
      </div>
    </div>
  );
}
