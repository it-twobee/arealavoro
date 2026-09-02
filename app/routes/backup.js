import express from 'express';
import { backupStatus, defaultBackupDir, runBackup, setBackupDir } from '../backup.js';

export const router = express.Router();

router.get('/', (req, res) => {
  res.json({ ...backupStatus(), suggestedDir: defaultBackupDir() });
});

router.post('/now', (req, res) => {
  res.json(runBackup('manuale dalla dashboard'));
});

router.put('/dir', (req, res) => {
  setBackupDir(req.body?.dir);
  res.json(backupStatus());
});
