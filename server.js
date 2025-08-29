const express = require("express")
const dotenv = require("dotenv")
const cors = require('cors')
const connectDB = require('./config/db')


dotenv.config();

connectDB();

const app = express()


app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.path} - ${new Date().toISOString()}`);
    console.log('📋 Headers:', req.headers);
    next();
});
app.use(cors());
app.use(express.json());

app.use("/api/v1/auth", require("./routes/v1/auth"));
app.get('/', (req,res)=>{
    res.send("othello API is running");
})

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`server running on port ${PORT}`))

 console.log(`🚀 Server running on port ${PORT}`);
