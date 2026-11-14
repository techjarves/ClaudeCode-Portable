export function isComposerSubmitKey(event, compositionActive=false){
  return event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!compositionActive;
}
