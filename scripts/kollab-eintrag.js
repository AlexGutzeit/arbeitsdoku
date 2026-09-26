// Einstieg für das Notiz-Bündel — wird NICHT direkt ausgeführt, sondern von
// scripts/kollab-buendeln.js zu public/vendor/kollab.min.js zusammengefasst.
import * as Y from 'yjs';
import Quill from 'quill';
import QuillCursors from 'quill-cursors';
import { QuillBinding } from 'y-quill';
import * as awarenessProtocol from 'y-protocols/awareness.js';
Quill.register('modules/cursors', QuillCursors);
window.Kollab = { Y, Quill, QuillBinding, awarenessProtocol };
