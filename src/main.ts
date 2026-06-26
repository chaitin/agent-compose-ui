import { mount } from 'svelte';
import 'xterm/css/xterm.css';

import App from './App.svelte';
import './styles.css';

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
