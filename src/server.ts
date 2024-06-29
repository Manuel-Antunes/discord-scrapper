import { Actor } from 'apify';
import express from 'express';

const app = express();

app.get('/runs/last/dataset/items', async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 250000;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const desc = req.query.desc ? req.query.desc === '1' : false;

    const dataset = await Actor.openDataset();
    const data = await dataset.getData({
        desc,
        limit,
        offset,
    });
    return res.json(data);
});

export { app };
