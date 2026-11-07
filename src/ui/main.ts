// filepath: src/ui/main.ts
import { start } from './app.ts';

const root = document.getElementById('app');
if (root) void start(root);
