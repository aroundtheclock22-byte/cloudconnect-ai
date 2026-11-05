import { registerRootComponent } from 'expo';
import App from './src/App';
import { registerBackgroundHandlers } from './src/lib/calling';
registerBackgroundHandlers(); // VoIP push + CallKit/ConnectionService handlers must exist before the UI mounts
registerRootComponent(App);
