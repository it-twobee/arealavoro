import express from 'express';
import * as vault from '../vault.js';

export const router = express.Router();

router.get('/status', (req, res) => res.json(vault.status()));

router.post('/setup', (req, res) => {
  res.json(vault.setup(req.body?.password));
});

router.post('/unlock', (req, res) => {
  res.json(vault.unlock(req.body?.password));
});

router.post('/lock', (req, res) => res.json(vault.lock()));

router.post('/reset', (req, res) => {
  res.json(vault.reset(req.body?.password));
});
