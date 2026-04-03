import express, { Request, Response } from 'express';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/hello', (req: Request, res: Response) => {
  res.json({ message: 'Hello from MASSIVE SOLVER backend!' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
