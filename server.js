const express = require("express")
const dotenv = require("dotenv")
const cors = require('cors')
const connectDB = require('./config/db')
const http = require("http")
const socketIo = require('socket.io');

const { initializeSocket} = require('./socketHandler');


dotenv.config();

connectDB();

const app = express()


app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.path} - ${new Date().toISOString()}`);
    if(process.env.NODE_ENV !== 'production'){
        console.log('📋 Headers:', req.headers);
    }
    next();
});
//app.use(cors());
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' ? [process.env.FRONTEND_URL, 'https://your-deployed-frontend.vercel.app'] :'http://localhost:5173',
  credentials: true, // Allow cookies to be sent
  methods:['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});
app.use("/api/v1/auth", require("./routes/v1/auth"));
app.get('/', (req, res) => {
    res.json({
        message: "Othello API is running",
        version: "1.0.0",
        status: "healthy"
    });
});


const server = http.createServer(app)

const io = initializeSocket(server);
// const io = socketIo(server, {
//   cors: {
//     origin: "http://localhost:5173", // Frontend URL
//     methods: ["GET", "POST"],
//     credentials: true
//   },
//   transports: ['websocket', 'polling'] 
// });

// io.on('connection', (socket) => {
//   console.log('A user connected:', socket.id);

//   // Listen for messages from client
//   socket.on('message', (data) => {
//     console.log('Message received:', data);
    
//     // Send message to all connected clients
//     io.emit('message', {
//       id: socket.id,
//       message: data.message,
//       timestamp: new Date().toISOString()
//     });
//   });
//   socket.on('join_room', (room) => {
//     socket.join(room);
//     console.log(`User ${socket.id} joined room: ${room}`);
//   });
//   socket.on('disconnect', () => {
//     console.log('User disconnected:', socket.id);
//   });
// });
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV}`);
});


process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        console.log('Process terminated');
    });
});
