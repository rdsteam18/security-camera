const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
  res.send({ status: 'ok', uptime: process.uptime() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Registry of connected devices
// Key: socket.id -> Value: { deviceId, role, status: { battery, charging, flashlight, alarm, sensitivity, volume } }
const devices = new Map();

// Helper to get all cameras
function getActiveCameras() {
  const list = [];
  for (const [socketId, info] of devices.entries()) {
    if (info.role === 'camera') {
      list.push({
        socketId,
        deviceId: info.deviceId,
        status: info.status || {}
      });
    }
  }
  return list;
}

// Broadcast active camera list to all dashboards
function broadcastCameraList() {
  const cameras = getActiveCameras();
  io.to('dashboard').emit('camera-list-update', cameras);
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Register device role & name
  socket.on('register', ({ deviceId, role, status }) => {
    if (!role || !deviceId) {
      console.warn('Registration failed: missing role or deviceId');
      return;
    }

    // Store in registry
    devices.set(socket.id, { deviceId, role, status });
    socket.join(role);
    socket.join(`device:${deviceId}`);
    
    console.log(`Registered device: ${deviceId} as ${role}`);

    // If it's a camera, notify dashboards
    if (role === 'camera') {
      broadcastCameraList();
    } else if (role === 'dashboard') {
      // Send current camera list to the newly connected dashboard
      socket.emit('camera-list-update', getActiveCameras());
    }
  });

  // Camera reports state updates (siren, battery, flashlight)
  socket.on('status-update', ({ status }) => {
    const info = devices.get(socket.id);
    if (info) {
      info.status = { ...info.status, ...status };
      devices.set(socket.id, info);
      broadcastCameraList();
    }
  });

  // WebRTC Stream Request: Dashboard -> Server -> Camera
  socket.on('request-stream', ({ targetDeviceId }) => {
    console.log(`Dashboard ${socket.id} requesting stream from camera: ${targetDeviceId}`);
    // Broadcast to the target camera room
    socket.to(`device:${targetDeviceId}`).emit('request-stream', {
      fromSocketId: socket.id
    });
  });

  // WebRTC signaling: Relay offer from Camera -> Dashboard (or vice versa)
  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    socket.to(targetSocketId).emit('webrtc-offer', {
      fromSocketId: socket.id,
      offer
    });
  });

  // WebRTC signaling: Relay answer from Dashboard -> Camera
  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    socket.to(targetSocketId).emit('webrtc-answer', {
      fromSocketId: socket.id,
      answer
    });
  });

  // WebRTC signaling: Relay ICE Candidate
  socket.on('ice-candidate', ({ targetSocketId, candidate }) => {
    socket.to(targetSocketId).emit('ice-candidate', {
      fromSocketId: socket.id,
      candidate
    });
  });

  // Command routing: Dashboard -> Server -> Camera
  socket.on('send-command', ({ targetDeviceId, command, value }) => {
    console.log(`Sending command '${command}' with value ${value} to ${targetDeviceId}`);
    
    // Relay command to the camera device
    socket.to(`device:${targetDeviceId}`).emit('command', { command, value });
  });

  // Motion/Intrusion Event: Camera -> Server
  socket.on('motion-detected', ({ motionScore }) => {
    const info = devices.get(socket.id);
    if (info && info.role === 'camera') {
      console.log(`🚨 Intrusion Alert! Camera '${info.deviceId}' detected motion (Score: ${motionScore})`);
      
      // Notify all dashboards
      io.to('dashboard').emit('intrusion-alert', {
        deviceId: info.deviceId,
        motionScore
      });

      // Broadcast siren trigger to ALL cameras for Surround Alarm
      io.to('camera').emit('command', { command: 'toggle-alarm', value: true });
    }
  });

  // Dashboard Heartbeat: Dashboard -> Camera (relayed by server)
  socket.on('ping-camera', ({ targetDeviceId }) => {
    socket.to(`device:${targetDeviceId}`).emit('ping-camera', {
      fromSocketId: socket.id
    });
  });

  // Camera Heartbeat Response: Camera -> Dashboard (relayed by server)
  socket.on('pong-camera', ({ targetSocketId }) => {
    socket.to(targetSocketId).emit('pong-camera', {
      fromSocketId: socket.id
    });
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    const info = devices.get(socket.id);
    if (info) {
      console.log(`Disconnected device: ${info.deviceId} (${info.role})`);
      devices.delete(socket.id);

      if (info.role === 'camera') {
        // Notify dashboards that a camera disconnected
        io.to('dashboard').emit('camera-disconnected', {
          deviceId: info.deviceId,
          socketId: socket.id
        });
        broadcastCameraList();
      }
    } else {
      console.log(`Socket disconnected: ${socket.id} (unregistered)`);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling & Command Server running on http://0.0.0.0:${PORT}`);
});
