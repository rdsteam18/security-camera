'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Camera, LayoutDashboard, Settings, Info } from 'lucide-react';

export default function Home() {
  const router = useRouter();
  const [serverUrl, setServerUrl] = useState('http://localhost:3001');
  const [deviceName, setDeviceName] = useState('Camera Node 1');
  const [showConfig, setShowConfig] = useState(false);
  const [hasSavedServer, setHasSavedServer] = useState(true);

  // Load saved configurations
  useEffect(() => {
    const savedServer = typeof window !== 'undefined' ? localStorage.getItem('dukan_security_server') : null;
    const savedName = typeof window !== 'undefined' ? localStorage.getItem('dukan_security_device_name') : null;
    
    if (savedServer) {
      setServerUrl(savedServer);
      setHasSavedServer(true);
    } else {
      setHasSavedServer(false);
      // Automatically try to resolve local IP if not localhost
      if (typeof window !== 'undefined') {
        const hostname = window.location.hostname;
        if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
          setServerUrl(`http://${hostname}:3001`);
        }
      }
    }
    
    if (savedName) setDeviceName(savedName);
  }, []);

  const saveConfig = (url: string, name: string) => {
    localStorage.setItem('dukan_security_server', url);
    localStorage.setItem('dukan_security_device_name', name);
  };

  const handleLaunchCamera = () => {
    saveConfig(serverUrl, deviceName);
    const encodedUrl = encodeURIComponent(serverUrl);
    const encodedName = encodeURIComponent(deviceName);
    router.push(`/camera?id=${encodedName}&server=${encodedUrl}`);
  };

  const handleLaunchDashboard = () => {
    saveConfig(serverUrl, deviceName);
    const encodedUrl = encodeURIComponent(serverUrl);
    router.push(`/dashboard?server=${encodedUrl}`);
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4 relative overflow-hidden font-sans">
      {/* Background Decorative elements */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.15),rgba(255,255,255,0))]" />
      <div className="absolute top-10 left-10 w-72 h-72 bg-blue-500/10 rounded-full blur-3xl" />
      <div className="absolute bottom-10 right-10 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl" />

      <div className="w-full max-w-xl bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl z-10 space-y-8">
        
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center p-3.5 bg-red-500/10 border border-red-500/20 text-red-400 rounded-2xl shadow-inner shadow-red-500/5 pulse-red">
            <Shield className="w-8 h-8 animate-pulse" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-slate-50 via-slate-100 to-slate-400 bg-clip-text text-transparent">
              DUKAN SECURITY AI
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Ultra Advanced Shop Surveillance & Control Network
            </p>
          </div>
        </div>

        {/* Configuration Panel */}
        <div className="bg-slate-950/50 border border-slate-800/80 rounded-2xl p-4 space-y-4">
          <button 
            onClick={() => setShowConfig(!showConfig)}
            className="flex items-center justify-between w-full text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition"
          >
            <span className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-blue-400" />
              Network & Server Configuration
            </span>
            <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-blue-300">
              {showConfig ? 'Hide' : 'Show'}
            </span>
          </button>

          {(showConfig || !hasSavedServer) && (
            <div className="space-y-3 pt-2 text-sm animate-fadeIn">
              <div className="space-y-1">
                <label className="text-xs text-slate-400 font-medium">Socket server URL</label>
                <input 
                  type="text" 
                  value={serverUrl} 
                  onChange={(e) => setServerUrl(e.target.value)} 
                  placeholder="http://192.168.1.XX:3001" 
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500 transition"
                />
                <p className="text-[10px] text-slate-500 flex items-center gap-1">
                  <Info className="w-3.5 h-3.5 text-blue-400/70" />
                  Must be your laptop's local network IP for mobile device connections.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Roles Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          
          {/* Camera Node (Slave) */}
          <div className="bg-slate-950/30 hover:bg-slate-950/50 border border-slate-800 hover:border-slate-700/80 rounded-2xl p-5 flex flex-col justify-between transition-all group">
            <div className="space-y-3">
              <div className="p-2.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-xl w-fit group-hover:scale-105 transition-transform">
                <Camera className="w-6 h-6" />
              </div>
              <div>
                <h2 className="font-bold text-slate-200 text-base">Camera Node</h2>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Leave an old smartphone in the shop. Serves as camera, motion sensor, and alarm siren.
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <div className="space-y-1">
                <label className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Device Label</label>
                <input 
                  type="text" 
                  value={deviceName} 
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g. Counter Cam" 
                  className="w-full text-xs bg-slate-900 border border-slate-800 focus:border-blue-500 rounded-lg px-2.5 py-1.5 focus:outline-none text-slate-200 transition"
                />
              </div>
              <button 
                onClick={handleLaunchCamera}
                className="w-full bg-blue-600 hover:bg-blue-500 text-slate-100 text-xs font-semibold py-2 rounded-xl transition shadow-lg shadow-blue-900/20"
              >
                Launch Camera Node
              </button>
            </div>
          </div>

          {/* Command Center (Master) */}
          <div className="bg-slate-950/30 hover:bg-slate-950/50 border border-slate-800 hover:border-slate-700/80 rounded-2xl p-5 flex flex-col justify-between transition-all group">
            <div className="space-y-3">
              <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl w-fit group-hover:scale-105 transition-transform">
                <LayoutDashboard className="w-6 h-6" />
              </div>
              <div>
                <h2 className="font-bold text-slate-200 text-base">Command Center</h2>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Access from your laptop/desktop at home. Monitor feeds, execute sirens, and receive intrusion pings.
                </p>
              </div>
            </div>

            <div className="mt-5">
              <button 
                onClick={handleLaunchDashboard}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-slate-100 text-xs font-semibold py-2 rounded-xl transition shadow-lg shadow-emerald-900/20 mt-auto"
              >
                Open Dashboard
              </button>
            </div>
          </div>

        </div>

        {/* Footer info */}
        <div className="text-center text-[10px] text-slate-500 border-t border-slate-800/80 pt-4 flex justify-between items-center px-1">
          <span>Version 1.0.0 (Phase 1)</span>
          <span className="flex items-center gap-1 text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-ping inline-block"></span>
            System Ready
          </span>
        </div>
      </div>
    </main>
  );
}
