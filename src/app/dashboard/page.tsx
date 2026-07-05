'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { 
  Shield, 
  Volume2, 
  Camera, 
  Lightbulb, 
  RefreshCw, 
  Zap, 
  Activity, 
  AlertTriangle, 
  ArrowLeft,
  Grid,
  Radio,
  Sliders,
  BellRing,
  VolumeX
} from 'lucide-react';

interface CameraDevice {
  socketId: string;
  deviceId: string;
  status: {
    battery?: number;
    charging?: boolean;
    flashlight?: boolean;
    alarm?: boolean;
    sensitivity?: number;
    volume?: number;
    facingMode?: 'user' | 'environment';
    isMonitoring?: boolean;
  };
  missedPings?: number;
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const serverUrl = searchParams.get('server') || 'http://localhost:3001';

  // State
  const [isConnected, setIsConnected] = useState(false);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [criticalAlarmActive, setCriticalAlarmActive] = useState(false);
  const [alarmReason, setAlarmReason] = useState('');
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);

  // Refs
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const streamsRef = useRef<Map<string, MediaStream>>(new Map());
  const videoElementsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const missedPingsRef = useRef<Map<string, number>>(new Map());

  // Local alert audio refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sirenIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Connect to socket.io
  useEffect(() => {
    console.log(`Dashboard connecting to: ${serverUrl}`);
    const socket = io(serverUrl, {
      reconnectionAttempts: 5,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Dashboard socket connected');
      setIsConnected(true);
      socket.emit('register', {
        deviceId: 'Command Center',
        role: 'dashboard'
      });
    });

    socket.on('disconnect', () => {
      console.log('Dashboard socket disconnected');
      setIsConnected(false);
    });

    // Receive updated camera list
    socket.on('camera-list-update', (updatedList: CameraDevice[]) => {
      console.log('Camera list update received:', updatedList);
      
      setCameras((prevCameras) => {
        // Find cameras that are new and request their stream
        updatedList.forEach((cam) => {
          const exists = prevCameras.some((p) => p.deviceId === cam.deviceId);
          if (!exists) {
            console.log(`Requesting stream for new camera: ${cam.deviceId}`);
            // Wait a small delay for registration to complete fully
            setTimeout(() => {
              socket.emit('request-stream', { targetDeviceId: cam.deviceId });
            }, 1000);
          }

          // Initialize ping counters for new cameras
          if (!missedPingsRef.current.has(cam.deviceId)) {
            missedPingsRef.current.set(cam.deviceId, 0);
          }
        });

        // Clean up closed connections for cameras that disappeared
        prevCameras.forEach((prevCam) => {
          const stillExists = updatedList.some((u) => u.deviceId === prevCam.deviceId);
          if (!stillExists) {
            console.log(`Cleaning up old camera: ${prevCam.deviceId}`);
            closePeerConnection(prevCam.socketId);
            missedPingsRef.current.delete(prevCam.deviceId);
          }
        });

        return updatedList.map((cam) => ({
          ...cam,
          missedPings: missedPingsRef.current.get(cam.deviceId) || 0
        }));
      });
    });

    // WebRTC Signaling relays
    socket.on('webrtc-offer', async ({ fromSocketId, offer }) => {
      console.log(`Received WebRTC offer from camera socket: ${fromSocketId}`);
      try {
        await handleReceiveOffer(fromSocketId, offer);
      } catch (err) {
        console.error('Error handling WebRTC offer:', err);
      }
    });

    socket.on('ice-candidate', async ({ fromSocketId, candidate }) => {
      const pc = peerConnectionsRef.current.get(fromSocketId);
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    // Connection drop alert from server
    socket.on('camera-disconnected', ({ deviceId }) => {
      console.warn(`🚨 CAMERA SYSTEM OFFLINE: ${deviceId}`);
      triggerDashboardCriticalAlarm(`CONNECTION LOST: ${deviceId} went offline!`);
    });

    // Sound/Intrusion alert from server
    socket.on('intrusion-alert', ({ deviceId, motionScore }) => {
      console.warn(`🚨 INTRUSION DETECTED on ${deviceId} (Motion: ${motionScore}%)`);
      triggerDashboardCriticalAlarm(`INTRUSION WARNING: Activity on ${deviceId}!`);
    });

    // Pong Heartbeat response from camera
    socket.on('pong-camera', ({ fromSocketId }) => {
      // Find camera deviceId matching fromSocketId
      setCameras((prev) => {
        const matchingCam = prev.find((c) => c.socketId === fromSocketId);
        if (matchingCam) {
          missedPingsRef.current.set(matchingCam.deviceId, 0);
        }
        return prev.map((c) => 
          c.socketId === fromSocketId ? { ...c, missedPings: 0 } : c
        );
      });
    });

    // 5-second Heartbeat checker
    const heartbeatInterval = setInterval(() => {
      setCameras((prev) => {
        prev.forEach((cam) => {
          const currentMissed = missedPingsRef.current.get(cam.deviceId) || 0;
          const updatedMissed = currentMissed + 1;
          missedPingsRef.current.set(cam.deviceId, updatedMissed);

          console.log(`Pinging camera ${cam.deviceId}. Missed: ${updatedMissed}/3`);
          
          // Send ping via server
          socket.emit('ping-camera', { targetDeviceId: cam.deviceId });

          // Check if missed limit hit
          if (updatedMissed >= 3) {
            triggerDashboardCriticalAlarm(`PING TIME-OUT: ${cam.deviceId} failed to respond!`);
          }
        });

        return prev.map((c) => ({
          ...c,
          missedPings: missedPingsRef.current.get(c.deviceId) || 0
        }));
      });
    }, 5000);

    return () => {
      clearInterval(heartbeatInterval);
      socket.disconnect();
      // Close all peer connections
      peerConnectionsRef.current.forEach((pc) => pc.close());
      stopDashboardSiren();
    };
  }, [serverUrl]);

  // WebRTC handling: Receive Offer & Create Answer
  const handleReceiveOffer = async (cameraSocketId: string, offer: any) => {
    if (peerConnectionsRef.current.has(cameraSocketId)) {
      closePeerConnection(cameraSocketId);
    }

    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(configuration);
    peerConnectionsRef.current.set(cameraSocketId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', {
          targetSocketId: cameraSocketId,
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      console.log(`Received track from camera ${cameraSocketId}:`, event.streams[0]);
      const stream = event.streams[0];
      streamsRef.current.set(cameraSocketId, stream);

      // Attach stream to video element
      const videoEl = videoElementsRef.current.get(cameraSocketId);
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.play().catch(e => console.warn('Autoplay prevented:', e));
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (socketRef.current) {
      socketRef.current.emit('webrtc-answer', {
        targetSocketId: cameraSocketId,
        answer
      });
    }
  };

  const closePeerConnection = (socketId: string) => {
    const pc = peerConnectionsRef.current.get(socketId);
    if (pc) {
      pc.close();
      peerConnectionsRef.current.delete(socketId);
    }
    streamsRef.current.delete(socketId);
  };

  // Remote Control command sender
  const sendRemoteCommand = (targetDeviceId: string, command: string, value: any) => {
    if (socketRef.current) {
      socketRef.current.emit('send-command', { targetDeviceId, command, value });
    }
  };

  // Remote controls for specific node
  const toggleNodeSiren = (cam: CameraDevice) => {
    const nextState = !cam.status.alarm;
    sendRemoteCommand(cam.deviceId, 'toggle-alarm', nextState);
  };

  const toggleNodeFlashlight = (cam: CameraDevice) => {
    const nextState = !cam.status.flashlight;
    sendRemoteCommand(cam.deviceId, 'toggle-flashlight', nextState);
  };

  const switchNodeSensor = (cam: CameraDevice) => {
    sendRemoteCommand(cam.deviceId, 'switch-camera', true);
  };

  const toggleNodeMonitoring = (cam: CameraDevice) => {
    const nextState = !cam.status.isMonitoring;
    sendRemoteCommand(cam.deviceId, 'toggle-monitoring', nextState);
  };

  const adjustNodeVolume = (cam: CameraDevice, val: number) => {
    sendRemoteCommand(cam.deviceId, 'change-volume', val);
  };

  const adjustNodeSensitivity = (cam: CameraDevice, val: number) => {
    sendRemoteCommand(cam.deviceId, 'change-sensitivity', val);
  };

  // Surround Alarm (Trigger all sirens)
  const triggerSurroundAlarm = () => {
    cameras.forEach((cam) => {
      sendRemoteCommand(cam.deviceId, 'toggle-alarm', true);
    });
  };

  const muteSurroundAlarm = () => {
    cameras.forEach((cam) => {
      sendRemoteCommand(cam.deviceId, 'toggle-alarm', false);
    });
  };

  // Dashboard Siren (Local sound warning)
  const triggerDashboardCriticalAlarm = (reason: string) => {
    setAlarmReason(reason);
    setCriticalAlarmActive(true);

    try {
      if (audioCtxRef.current) return; // Already running

      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = audioCtx;

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(800, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.8, audioCtx.currentTime); // High volume warning

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();

      oscRef.current = osc;
      gainRef.current = gain;

      // Heavy warning warble
      let toggle = true;
      sirenIntervalRef.current = setInterval(() => {
        if (oscRef.current) {
          oscRef.current.frequency.setValueAtTime(toggle ? 1000 : 700, audioCtx.currentTime);
          toggle = !toggle;
        }
      }, 150);

    } catch (err) {
      console.warn('Dashboard sound warning failed to load:', err);
    }
  };

  const stopDashboardSiren = () => {
    setCriticalAlarmActive(false);
    setAlarmReason('');

    if (sirenIntervalRef.current) {
      clearInterval(sirenIntervalRef.current);
      sirenIntervalRef.current = null;
    }
    if (oscRef.current) {
      try { oscRef.current.stop(); } catch(e){}
      oscRef.current.disconnect();
      oscRef.current = null;
    }
    if (gainRef.current) {
      gainRef.current.disconnect();
      gainRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch(e){}
      audioCtxRef.current = null;
    }
  };

  // Bind video element helper
  const setVideoRef = (socketId: string, el: HTMLVideoElement | null) => {
    if (el) {
      videoElementsRef.current.set(socketId, el);
      // If we already have the stream cached, attach it immediately
      const cachedStream = streamsRef.current.get(socketId);
      if (cachedStream && el.srcObject !== cachedStream) {
        el.srcObject = cachedStream;
        el.play().catch(e => console.warn('Play prevented:', e));
      }
    } else {
      videoElementsRef.current.delete(socketId);
    }
  };

  const selectedCamera = cameras.find((c) => c.deviceId === selectedCameraId) || null;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans relative">
      
      {/* Critical Alarm Banner */}
      {criticalAlarmActive && (
        <div className="bg-red-600 text-white font-bold px-4 py-3 flex items-center justify-between z-50 border-b-2 border-red-500 animate-pulse">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 animate-bounce text-yellow-300" />
            <div>
              <p className="text-sm tracking-wide">SYSTEM INTRUSION / DISCONNECT THREAT</p>
              <p className="text-xs font-semibold text-red-100 mt-0.5">{alarmReason}</p>
            </div>
          </div>
          <button 
            onClick={stopDashboardSiren}
            className="bg-black/40 hover:bg-black/60 border border-white/20 hover:border-white px-3 py-1.5 rounded-lg text-xs transition"
          >
            DISMISS ALERT
          </button>
        </div>
      )}

      {/* Top Header */}
      <header className="bg-slate-900/90 backdrop-blur border-b border-slate-800 px-6 py-4 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => router.push('/')}
            className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="font-extrabold text-slate-100 text-base sm:text-lg flex items-center gap-2.5">
              <Shield className="w-5 h-5 text-red-500 animate-pulse" />
              COMMAND CENTER
            </h1>
            <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
              <span className={`w-2 h-2 rounded-full inline-block ${isConnected ? 'bg-green-500 shadow-md shadow-green-500' : 'bg-red-500 animate-ping'}`} />
              {isConnected ? 'Signaling Hub Online' : 'Connecting to Server...'}
            </p>
          </div>
        </div>

        {/* Global Controls */}
        <div className="flex items-center gap-2">
          {cameras.length > 0 && (
            <>
              <button 
                onClick={triggerSurroundAlarm}
                className="bg-red-600 hover:bg-red-500 text-white font-bold py-1.5 px-3 rounded-lg text-xs transition shadow-lg shadow-red-950/20 flex items-center gap-1.5"
              >
                <BellRing className="w-4 h-4" />
                SIREN ALL
              </button>
              <button 
                onClick={muteSurroundAlarm}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold py-1.5 px-3 rounded-lg text-xs transition flex items-center gap-1.5"
              >
                <VolumeX className="w-4 h-4" />
                MUTE ALL
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Panel Content */}
      <div className="flex-1 flex flex-col lg:flex-row p-6 gap-6 max-w-7xl mx-auto w-full">
        
        {/* Cameras Feed Grid */}
        <div className="flex-1 flex flex-col space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-200 text-sm tracking-wide uppercase flex items-center gap-2">
              <Grid className="w-4.5 h-4.5 text-blue-400" />
              Surveillance Grid ({cameras.length} Active Node{cameras.length !== 1 ? 's' : ''})
            </h2>
            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold flex items-center gap-1 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
              <Radio className="w-3 h-3 text-red-500 animate-pulse" />
              WebRTC Live Stream
            </div>
          </div>

          {cameras.length === 0 ? (
            <div className="flex-1 border-2 border-dashed border-slate-800 rounded-3xl flex flex-col items-center justify-center text-slate-500 p-8 min-h-[300px]">
              <Camera className="w-16 h-16 text-slate-700 animate-pulse mb-3" />
              <p className="text-sm font-semibold">No cameras registered on your server</p>
              <p className="text-xs text-slate-600 mt-1 max-w-sm text-center">
                Launch a Camera Node on a smartphone and direct it to connect to this server IP.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
              {cameras.map((cam) => {
                const isSelected = selectedCameraId === cam.deviceId;
                const isThreat = (cam.missedPings ?? 0) > 0 || cam.status.alarm;
                
                return (
                  <div 
                    key={cam.deviceId}
                    onClick={() => setSelectedCameraId(cam.deviceId)}
                    className={`flex flex-col bg-slate-900 rounded-2xl overflow-hidden border transition-all cursor-pointer group hover:scale-[1.01] ${isSelected ? 'border-blue-500 shadow-2xl shadow-blue-900/10' : isThreat ? 'border-red-500' : 'border-slate-800 hover:border-slate-700'}`}
                  >
                    
                    {/* Stream display */}
                    <div className="aspect-video bg-black relative flex items-center justify-center overflow-hidden">
                      <video 
                        ref={(el) => setVideoRef(cam.socketId, el)} 
                        autoPlay 
                        playsInline 
                        muted 
                        className="w-full h-full object-cover"
                      />
                      
                      {/* Critical visual drop warning overlay */}
                      {(cam.missedPings ?? 0) > 0 && (
                        <div className="absolute inset-0 bg-red-950/70 backdrop-blur-sm z-10 flex flex-col items-center justify-center p-4 text-center">
                          <AlertTriangle className="w-10 h-10 text-red-500 animate-bounce mb-2" />
                          <p className="font-extrabold text-sm text-red-400">HEARTBEAT LOST</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            Missed: {cam.missedPings}/3 pings. Checking connection...
                          </p>
                        </div>
                      )}

                      {/* Intrusion alarm warning overlay */}
                      {cam.status.alarm && !(cam.missedPings && cam.missedPings > 0) && (
                        <div className="absolute inset-0 bg-red-600/20 border-4 border-red-500 animate-pulse pointer-events-none z-10 flex items-center justify-center">
                          <div className="bg-red-800 text-white font-bold px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 border border-red-400">
                            <AlertTriangle className="w-3.5 h-3.5 text-yellow-300 animate-pulse" />
                            SIREN ACTIVE
                          </div>
                        </div>
                      )}

                      {/* Status pill overlay */}
                      <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded border border-slate-800/80 text-[9px] text-slate-300 flex items-center gap-1.5 font-bold uppercase tracking-wider">
                        <span className={`w-1.5 h-1.5 rounded-full ${cam.status.alarm ? 'bg-red-500 animate-ping' : 'bg-emerald-500'}`} />
                        {cam.deviceId}
                      </div>

                      {/* Battery overlay */}
                      <div className="absolute top-3 right-3 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded border border-slate-800/80 text-[9px] text-slate-300 flex items-center gap-1 font-bold">
                        <Zap className={`w-2.5 h-2.5 ${cam.status.charging ? 'text-yellow-400 fill-yellow-400 animate-bounce' : 'text-slate-400'}`} />
                        {cam.status.battery}%
                      </div>
                    </div>

                    {/* Camera info / footer */}
                    <div className="p-3 bg-slate-900 border-t border-slate-800 flex justify-between items-center text-xs">
                      <div className="flex gap-3">
                        <span className="text-slate-400 flex items-center gap-1">
                          <Activity className={`w-3.5 h-3.5 ${cam.status.isMonitoring ? 'text-emerald-400' : 'text-slate-500'}`} />
                          {cam.status.isMonitoring ? 'Armed' : 'Disarmed'}
                        </span>
                        <span className="text-slate-400 flex items-center gap-1">
                          <Lightbulb className={`w-3.5 h-3.5 ${cam.status.flashlight ? 'text-yellow-400 fill-yellow-400' : 'text-slate-500'}`} />
                          Flash: {cam.status.flashlight ? 'ON' : 'OFF'}
                        </span>
                      </div>
                      <span className="text-slate-500 text-[10px] font-mono">
                        {cam.status.facingMode === 'environment' ? 'Rear Cam' : 'Front Cam'}
                      </span>
                    </div>

                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Camera Settings Panel */}
        <div className="w-full lg:w-80 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-2xl space-y-4">
            <h2 className="font-extrabold text-slate-200 text-sm tracking-wide uppercase border-b border-slate-800 pb-2 flex items-center gap-2">
              <Sliders className="w-4 h-4 text-blue-400" />
              Node Settings
            </h2>

            {selectedCamera ? (
              <div className="space-y-5">
                {/* Header info */}
                <div className="space-y-1">
                  <p className="text-xs text-slate-500 uppercase font-bold tracking-wider">Selected Device</p>
                  <p className="text-sm font-bold text-slate-200">{selectedCamera.deviceId}</p>
                  <p className="text-[10px] text-slate-400 font-mono">Socket: {selectedCamera.socketId.substring(0, 10)}...</p>
                </div>

                {/* Quick Controls */}
                <div className="space-y-2">
                  <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Device Controls</p>
                  
                  {/* Armed monitoring state */}
                  <button 
                    onClick={() => toggleNodeMonitoring(selectedCamera)}
                    className={`w-full font-bold py-2.5 rounded-xl text-xs transition border ${selectedCamera.status.isMonitoring ? 'bg-emerald-950/40 hover:bg-emerald-900/40 border-emerald-900/60 hover:border-emerald-500 text-emerald-400' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}
                  >
                    {selectedCamera.status.isMonitoring ? 'Armed: Monitoring' : 'Disarmed: Stop'}
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button 
                      onClick={() => toggleNodeSiren(selectedCamera)}
                      className={`font-bold py-2 px-3 rounded-xl text-xs transition border ${selectedCamera.status.alarm ? 'bg-red-600 hover:bg-red-500 text-white border-red-500' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}
                    >
                      {selectedCamera.status.alarm ? 'Siren ON' : 'Siren OFF'}
                    </button>
                    <button 
                      onClick={() => toggleNodeFlashlight(selectedCamera)}
                      className={`font-bold py-2 px-3 rounded-xl text-xs transition border ${selectedCamera.status.flashlight ? 'bg-yellow-600 hover:bg-yellow-500 text-white border-yellow-400' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}
                    >
                      Flashlight
                    </button>
                  </div>

                  <button 
                    onClick={() => switchNodeSensor(selectedCamera)}
                    className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold py-2 rounded-xl text-xs transition flex items-center justify-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Flip Camera Sensor
                  </button>
                </div>

                {/* Range Sliders */}
                <div className="space-y-4 pt-2 border-t border-slate-800">
                  
                  {/* Volume Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-slate-400">Alarm Volume</span>
                      <span className="text-slate-300 font-mono">
                        {selectedCamera.status.volume !== undefined ? `${Math.round(selectedCamera.status.volume * 100)}%` : '80%'}
                      </span>
                    </div>
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      value={(selectedCamera.status.volume ?? 0.8) * 100} 
                      onChange={(e) => adjustNodeVolume(selectedCamera, parseInt(e.target.value) / 100)}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-red-500"
                    />
                  </div>

                  {/* Sensitivity Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-slate-400">Motion Sensitivity</span>
                      <span className="text-slate-300 font-mono">
                        {selectedCamera.status.sensitivity ?? '50'}%
                      </span>
                    </div>
                    <input 
                      type="range" 
                      min="1" 
                      max="100" 
                      value={selectedCamera.status.sensitivity ?? 50} 
                      onChange={(e) => adjustNodeSensitivity(selectedCamera, parseInt(e.target.value))}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                  </div>

                </div>

              </div>
            ) : (
              <div className="text-center text-xs text-slate-500 py-8">
                Click on a camera feed in the grid to view and modify its specific settings.
              </div>
            )}
          </div>
        </div>

      </div>
    </main>
  );
}

export default function Dashboard() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center font-semibold text-sm">Loading Command Center...</div>}>
      <DashboardContent />
    </Suspense>
  );
}
