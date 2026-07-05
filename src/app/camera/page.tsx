'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { Camera, Volume2, Shield, AlertTriangle, Lightbulb, Zap, ArrowLeft, RefreshCw } from 'lucide-react';

function CameraNodeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const deviceId = searchParams.get('id') || 'Camera Node';
  const serverUrl = searchParams.get('server') || 'http://localhost:3001';

  // State
  const [isConnected, setIsConnected] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [alarmActive, setAlarmActive] = useState(false);
  const [flashlightActive, setFlashlightActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [sensitivity, setSensitivity] = useState(50);
  const [volume, setVolume] = useState(0.8);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [isCharging, setIsCharging] = useState<boolean | null>(null);
  const [motionScore, setMotionScore] = useState(0);

  // Refs for WebRTC & Canvas Diff
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());

  // Refs for Audio Siren
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sirenIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Refs for Motion detection loop
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);

  // Update status object helper
  const getStatusObject = () => ({
    battery: batteryLevel ?? 100,
    charging: isCharging ?? true,
    flashlight: flashlightActive,
    alarm: alarmActive,
    sensitivity,
    volume,
    facingMode,
    isMonitoring
  });

  // Emit status helper
  const emitStatusUpdate = () => {
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('status-update', { status: getStatusObject() });
    }
  };

  // 1. Manage Socket.io connection
  useEffect(() => {
    console.log(`Connecting to Socket server: ${serverUrl}`);
    const socket = io(serverUrl, {
      reconnectionAttempts: 5,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server!');
      setIsConnected(true);
      socket.emit('register', {
        deviceId,
        role: 'camera',
        status: getStatusObject()
      });
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      setIsConnected(false);
    });

    // Handle incoming WebRTC requests
    socket.on('request-stream', async ({ fromSocketId }) => {
      console.log(`Received stream request from dashboard socket: ${fromSocketId}`);
      try {
        await createPeerConnection(fromSocketId);
      } catch (err) {
        console.error('Failed to create PeerConnection:', err);
      }
    });

    socket.on('webrtc-answer', async ({ fromSocketId, answer }) => {
      console.log(`Received answer from: ${fromSocketId}`);
      const pc = peerConnectionsRef.current.get(fromSocketId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socket.on('ice-candidate', async ({ fromSocketId, candidate }) => {
      const pc = peerConnectionsRef.current.get(fromSocketId);
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    // Handle commands from Dashboard
    socket.on('command', async ({ command, value }) => {
      console.log(`Received command: ${command} = ${value}`);
      if (command === 'toggle-alarm') {
        if (value) startLocalSiren();
        else stopLocalSiren();
      } else if (command === 'toggle-flashlight') {
        setFlashlightActive(value);
      } else if (command === 'change-sensitivity') {
        setSensitivity(value);
      } else if (command === 'change-volume') {
        setVolume(value);
      } else if (command === 'switch-camera') {
        toggleCameraDirection();
      } else if (command === 'toggle-monitoring') {
        if (value) startMotionMonitoring();
        else stopMotionMonitoring();
      }
    });

    // Heartbeat ping from dashboard
    socket.on('ping-camera', ({ fromSocketId }) => {
      socket.emit('pong-camera', { targetSocketId: fromSocketId });
    });

    return () => {
      socket.disconnect();
      stopCameraStream();
      stopLocalSiren();
    };
  }, [serverUrl, deviceId]);

  // 2. Monitor Battery State
  useEffect(() => {
    const nav = navigator as any;
    if (typeof window === 'undefined' || !nav.getBattery) return;

    let batteryInstance: any = null;

    const updateBattery = () => {
      if (batteryInstance) {
        setBatteryLevel(Math.round(batteryInstance.level * 100));
        setIsCharging(batteryInstance.charging);
      }
    };

    nav.getBattery().then((battery: any) => {
      batteryInstance = battery;
      updateBattery();
      battery.addEventListener('levelchange', updateBattery);
      battery.addEventListener('chargingchange', updateBattery);
    });

    return () => {
      if (batteryInstance) {
        batteryInstance.removeEventListener('levelchange', updateBattery);
        batteryInstance.removeEventListener('chargingchange', updateBattery);
      }
    };
  }, []);

  // Update status automatically when relevant states change
  useEffect(() => {
    emitStatusUpdate();
  }, [batteryLevel, isCharging, flashlightActive, alarmActive, sensitivity, volume, facingMode, isMonitoring]);

  // 3. WebRTC Peer Connection negotiation
  const createPeerConnection = async (dashboardSocketId: string) => {
    // If connection already exists, close it first
    if (peerConnectionsRef.current.has(dashboardSocketId)) {
      peerConnectionsRef.current.get(dashboardSocketId)?.close();
    }

    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(configuration);
    peerConnectionsRef.current.set(dashboardSocketId, pc);

    // Send local stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, streamRef.current!);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', {
          targetSocketId: dashboardSocketId,
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`WebRTC Connection State with ${dashboardSocketId}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.close();
        peerConnectionsRef.current.delete(dashboardSocketId);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (socketRef.current) {
      socketRef.current.emit('webrtc-offer', {
        targetSocketId: dashboardSocketId,
        offer
      });
    }
  };

  // 4. Access Local Camera Media
  const startCameraStream = async () => {
    try {
      if (streamRef.current) {
        stopCameraStream();
      }

      console.log(`Starting media stream with facingMode: ${facingMode}`);
      const constraints = {
        video: {
          facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false // No audio needed for motion detection / standard stream to avoid echo
      };

      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = mediaStream;

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setIsCameraActive(true);

      // Refresh any active WebRTC tracks
      peerConnectionsRef.current.forEach((pc) => {
        // Remove existing senders
        pc.getSenders().forEach((sender) => pc.removeTrack(sender));
        // Add new tracks
        mediaStream.getTracks().forEach((track) => pc.addTrack(track, mediaStream));
        // Re-negotiate
        pc.createOffer().then((offer) => {
          pc.setLocalDescription(offer);
          if (socketRef.current) {
            const dashboardSocketId = [...peerConnectionsRef.current.entries()].find(([_, connection]) => connection === pc)?.[0];
            if (dashboardSocketId) {
              socketRef.current.emit('webrtc-offer', { targetSocketId: dashboardSocketId, offer });
            }
          }
        });
      });

    } catch (err: any) {
      alert('Could not start camera: ' + err.message);
      console.error(err);
    }
  };

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
    stopMotionMonitoring();
  };

  const toggleCameraDirection = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  // Switch camera when facingMode state changes
  useEffect(() => {
    if (isCameraActive) {
      startCameraStream();
    }
  }, [facingMode]);

  // Handle Flashlight/Torch constraints
  useEffect(() => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;

    try {
      const capabilities = (track as any).getCapabilities?.() || {};
      if (capabilities.torch) {
        track.applyConstraints({
          advanced: [{ torch: flashlightActive } as any]
        });
      } else {
        console.warn('Torch function not supported by this browser/device sensor');
      }
    } catch (e) {
      console.warn('Error setting flashlight:', e);
    }
  }, [flashlightActive, isCameraActive]);

  // 5. Audio Siren (Siren sound synthesis)
  const startLocalSiren = () => {
    if (alarmActive) return;
    setAlarmActive(true);

    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = audioCtx;

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(500, audioCtx.currentTime);
      gain.gain.setValueAtTime(volume, audioCtx.currentTime);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();

      oscRef.current = osc;
      gainRef.current = gain;

      // Pitch sweep siren effect (warbling)
      let high = true;
      sirenIntervalRef.current = setInterval(() => {
        if (oscRef.current) {
          oscRef.current.frequency.setValueAtTime(high ? 800 : 500, audioCtx.currentTime);
          high = !high;
        }
      }, 200);

    } catch (e) {
      console.warn('Audio API initialization failed:', e);
    }
  };

  const stopLocalSiren = () => {
    setAlarmActive(false);
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

  // Adjust alarm volume if it is running
  useEffect(() => {
    if (gainRef.current && audioCtxRef.current) {
      gainRef.current.gain.setValueAtTime(volume, audioCtxRef.current.currentTime);
    }
  }, [volume]);

  // 6. Canvas Motion Detection loop
  const startMotionMonitoring = () => {
    if (!isCameraActive) {
      alert('Start camera first before enabling security monitoring!');
      return;
    }
    if (isMonitoring) return;
    setIsMonitoring(true);
    prevFrameRef.current = null;

    const detectMotion = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx || video.readyState !== video.HAVE_ENOUGH_DATA) {
        animationFrameIdRef.current = requestAnimationFrame(detectMotion);
        return;
      }

      // Draw downscaled frame for performance
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = frame.data;

      if (prevFrameRef.current) {
        const prev = prevFrameRef.current;
        let diffSum = 0;
        const totalPixels = data.length / 4;

        // Compare pixel intensity diffs
        for (let i = 0; i < data.length; i += 4) {
          const r = Math.abs(data[i] - prev[i]);
          const g = Math.abs(data[i + 1] - prev[i + 1]);
          const b = Math.abs(data[i + 2] - prev[i + 2]);
          diffSum += (r + g + b) / 3;
        }

        const avgDiff = diffSum / totalPixels;
        // Normalize between 0 and 100
        const currentScore = Math.min(100, Math.round(avgDiff * 1.8));
        setMotionScore(currentScore);

        // Threshold comparison (Mapped from sensitivity slider)
        const thresholdVal = 101 - sensitivity; // higher sensitivity = lower threshold (1..100)
        
        if (currentScore > thresholdVal && !alarmActive) {
          console.log(`🚨 Motion triggered! score=${currentScore}, threshold=${thresholdVal}`);
          startLocalSiren();

          // Report intrusion to backend
          if (socketRef.current) {
            socketRef.current.emit('motion-detected', { motionScore: currentScore });
          }
        }
      }

      // Save frame data
      prevFrameRef.current = new Uint8ClampedArray(data);
      animationFrameIdRef.current = requestAnimationFrame(detectMotion);
    };

    animationFrameIdRef.current = requestAnimationFrame(detectMotion);
  };

  const stopMotionMonitoring = () => {
    setIsMonitoring(false);
    setMotionScore(0);
    prevFrameRef.current = null;
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans relative">
      {/* Top Header */}
      <header className="bg-slate-900/80 backdrop-blur border-b border-slate-800 px-4 py-3 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => router.push('/')}
            className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="font-bold text-slate-200 flex items-center gap-2 text-sm sm:text-base">
              <span className={`w-2.5 h-2.5 rounded-full inline-block ${isConnected ? 'bg-green-500 shadow-md shadow-green-500' : 'bg-red-500 animate-pulse'}`} />
              {deviceId}
            </h1>
            <p className="text-[10px] text-slate-400">
              {isConnected ? `Connected to Signalling` : `Reconnecting to ${serverUrl}...`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 bg-slate-950/80 px-3 py-1 rounded-full border border-slate-800 text-xs">
          <Zap className={`w-3.5 h-3.5 ${isCharging ? 'text-yellow-400 fill-yellow-400 animate-bounce' : 'text-slate-400'}`} />
          <span className="font-semibold">{batteryLevel !== null ? `${batteryLevel}%` : '--%'}</span>
        </div>
      </header>

      {/* Screen Layout Grid */}
      <div className="flex-1 flex flex-col md:grid md:grid-cols-3 p-4 gap-4 max-w-5xl mx-auto w-full">
        
        {/* Live Camera View Column (Spans 2 cols on desktop) */}
        <div className="md:col-span-2 flex flex-col bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
          
          {/* Main Video View */}
          <div className="flex-1 min-h-[300px] bg-black relative flex items-center justify-center">
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="absolute inset-0 w-full h-full object-cover"
            />

            {/* Inactive state display */}
            {!isCameraActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 text-slate-400 gap-2">
                <Camera className="w-12 h-12 text-slate-600 animate-pulse" />
                <p className="text-sm font-semibold">Camera Stream Offline</p>
                <p className="text-xs text-slate-600">Activate using the controls below</p>
              </div>
            )}

            {/* Intrusion/Alarm Red overlay */}
            {alarmActive && (
              <div className="absolute inset-0 bg-red-600/30 border-4 border-red-500 animate-pulse pointer-events-none z-10 flex items-center justify-center">
                <div className="bg-red-700/90 text-slate-100 font-bold px-4 py-2 rounded-xl text-lg flex items-center gap-2 border border-red-400 shadow-2xl">
                  <AlertTriangle className="w-5 h-5 text-yellow-300 animate-bounce" />
                  SIREN ACTIVE
                </div>
              </div>
            )}

            {/* Info Overlay */}
            {isCameraActive && (
              <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded-lg border border-slate-800 text-[10px] text-slate-400 uppercase tracking-widest font-bold z-10">
                Live Feed • {facingMode === 'environment' ? 'Rear Sensor' : 'Front Sensor'}
              </div>
            )}
          </div>

          {/* Local Feed Controls */}
          <div className="p-3 bg-slate-900 border-t border-slate-800 flex gap-2">
            {!isCameraActive ? (
              <button 
                onClick={startCameraStream}
                className="flex-1 bg-blue-600 hover:bg-blue-500 text-slate-100 font-bold py-2.5 rounded-xl text-sm transition"
              >
                Start Camera Stream
              </button>
            ) : (
              <button 
                onClick={stopCameraStream}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold py-2.5 rounded-xl text-sm transition border border-slate-700"
              >
                Stop Camera Stream
              </button>
            )}

            {isCameraActive && (
              <button 
                onClick={toggleCameraDirection}
                title="Switch Camera Direction"
                className="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl transition"
              >
                <RefreshCw className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        {/* Security Settings & Diagnostic Logs Column */}
        <div className="space-y-4">
          
          {/* Security Controller */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl space-y-4">
            <h2 className="font-extrabold text-slate-200 text-sm tracking-wide uppercase border-b border-slate-800 pb-2 flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" />
              Intrusion Detector
            </h2>

            {/* Arm Button */}
            {!isMonitoring ? (
              <button 
                onClick={startMotionMonitoring}
                disabled={!isCameraActive}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-slate-100 font-bold py-3 rounded-xl text-sm transition shadow-lg shadow-emerald-950/20"
              >
                Arm Motion Sensor
              </button>
            ) : (
              <button 
                onClick={stopMotionMonitoring}
                className="w-full bg-yellow-600 hover:bg-yellow-500 text-slate-100 font-bold py-3 rounded-xl text-sm transition shadow-lg shadow-yellow-950/20"
              >
                Disarm Motion Sensor
              </button>
            )}

            {/* Motion gauge */}
            {isMonitoring && (
              <div className="space-y-2 pt-2">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-slate-400">Activity Level</span>
                  <span className="text-emerald-400 font-mono">{motionScore}%</span>
                </div>
                <div className="h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800 relative">
                  {/* Threshold mark */}
                  <div 
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10" 
                    style={{ left: `${101 - sensitivity}%` }}
                    title="Intrusion Threshold"
                  />
                  {/* Activity fill */}
                  <div 
                    className="h-full bg-gradient-to-r from-emerald-500 via-yellow-400 to-red-500 rounded-full transition-all duration-75"
                    style={{ width: `${motionScore}%` }}
                  />
                </div>
                <p className="text-[10px] text-slate-500 leading-normal">
                  Red indicator is threshold. Activity crossing it triggers alarm.
                </p>
              </div>
            )}
          </div>

          {/* Alarm Panel */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl space-y-4">
            <h2 className="font-extrabold text-slate-200 text-sm tracking-wide uppercase border-b border-slate-800 pb-2 flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-red-400" />
              Siren & Flashlight
            </h2>

            {/* Siren Trigger Buttons */}
            <div className="grid grid-cols-2 gap-2">
              {!alarmActive ? (
                <button 
                  onClick={startLocalSiren}
                  className="bg-red-950/40 hover:bg-red-900/40 border border-red-900/60 hover:border-red-500 text-red-400 font-bold py-2 px-3 rounded-xl text-xs transition"
                >
                  Test Siren
                </button>
              ) : (
                <button 
                  onClick={stopLocalSiren}
                  className="bg-red-600 hover:bg-red-500 text-white font-bold py-2 px-3 rounded-xl text-xs transition"
                >
                  Mute Siren
                </button>
              )}

              <button 
                onClick={() => setFlashlightActive(!flashlightActive)}
                className={`flex items-center justify-center gap-2 border font-bold py-2 px-3 rounded-xl text-xs transition ${flashlightActive ? 'bg-yellow-600 hover:bg-yellow-500 text-white border-yellow-400' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}
              >
                <Lightbulb className="w-3.5 h-3.5" />
                {flashlightActive ? 'Flash ON' : 'Flash OFF'}
              </button>
            </div>

            {/* Volume settings display */}
            <div className="space-y-1 pt-1">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">Volume</span>
                <span className="text-slate-300 font-mono">{(volume * 100).toFixed(0)}%</span>
              </div>
              <input 
                type="range" 
                min="0" 
                max="100" 
                value={volume * 100} 
                onChange={(e) => setVolume(parseInt(e.target.value) / 100)} 
                className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-red-500"
              />
            </div>
            
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">Sensitivity</span>
                <span className="text-slate-300 font-mono">{sensitivity}%</span>
              </div>
              <input 
                type="range" 
                min="1" 
                max="100" 
                value={sensitivity} 
                onChange={(e) => setSensitivity(parseInt(e.target.value))} 
                className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
            </div>
          </div>

        </div>

      </div>

      {/* Hidden Downscale canvas for pixel diffing */}
      <canvas ref={canvasRef} width="120" height="90" className="hidden" />
    </main>
  );
}

export default function CameraNode() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center font-semibold text-sm">Loading Camera Module...</div>}>
      <CameraNodeContent />
    </Suspense>
  );
}
