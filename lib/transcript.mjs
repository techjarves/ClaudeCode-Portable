export const transcriptTypes=new Set(['message','thinking','tool','tool_result','tool_status']);

// Previous versions saved messages and a capped event log separately. Rebuild
// only turns whose queued boundary survives, without guessing missing ordering.
export function sessionTranscript(session){
  if(Array.isArray(session.transcript))return session.transcript;
  const messages=session.messages||[],events=session.events||[];
  const users=messages.flatMap((m,i)=>m.role==='user'?[i]:[]);
  const boundaries=events.filter(e=>e.type==='status'&&e.status==='queued').length;
  const asMessage=m=>({type:'message',role:m.role,text:typeof m.content==='string'?m.content:JSON.stringify(m.content,null,2),...(m.attachments?.length?{attachments:m.attachments}:{})});
  if(!boundaries||boundaries>users.length){
    const activity=events.filter(e=>['tool','tool_result'].includes(e.type));
    return [...messages.map(asMessage),...(activity.length?[{type:'history_note',text:'Earlier tool activity · original message positions were not recorded'},...activity]:[])];
  }
  let user=users.length-boundaries;
  const result=messages.slice(0,users[user]).map(asMessage);
  for(const e of events.slice(events.findIndex(e=>e.type==='status'&&e.status==='queued'))){
    if(e.type==='status'&&e.status==='queued')result.push(asMessage(messages[users[user++]]));
    if(transcriptTypes.has(e.type))result.push(e.type==='message'?{...e,role:e.role||'assistant'}:e);
  }
  return result;
}
