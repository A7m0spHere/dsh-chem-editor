import { fragmentInputs, resolveFragment } from './fragments';

type Request = { operation: string; fragment?: string; element?: string; bondType?: number };
const fail = (code: string,message: string): never => { throw Object.assign(new Error(message),{code}); };
const aliases = [...fragmentInputs].sort((a,b)=>b.length-a.length);
const cleanTarget = (text: string) => text.trim().replace(/^(?:一个|一条|一种|1个|a\s+|an\s+|one\s+)/i,'').replace(/^[-–]/,'').trim();
function namedFragment(text: string) {
  const target=cleanTarget(text);
  const alias=aliases.find(name=>{
    if(!target.toLowerCase().startsWith(name.toLowerCase()))return false;
    const rest=target.slice(name.length);
    return !rest||/^[\s（(,，。.;；!?！？]/.test(rest)||/^(基团|片段|使用|采用|通过|保留|连接|到|以)/.test(rest);
  });
  return alias ? resolveFragment(alias) : undefined;
}
function element(text: string) {
  const target=cleanTarget(text);
  const names:Record<string,string>={碳:'C',氮:'N',氧:'O',硫:'S',磷:'P',氟:'F',氯:'Cl',溴:'Br',碘:'I'};
  for(const [name,id] of Object.entries(names))if(new RegExp(`^${name}(?:原子)?(?:$|[\\s，。,;；（(])`).test(target))return id;
  const english:Record<string,string>={carbon:'C',nitrogen:'N',oxygen:'O',sulfur:'S',phosphorus:'P',fluorine:'F',chlorine:'Cl',bromine:'Br',iodine:'I'};
  for(const [name,id] of Object.entries(english))if(new RegExp(`^${name}\\b`,'i').test(target))return id;
  return target.match(/^(Cl|Br|C|N|O|S|P|F|I)(?=$|[^A-Za-z0-9])/i)?.[1]?.replace(/^./,c=>c.toUpperCase()).replace(/L$/,'l').replace(/R$/,'r');
}
// Deliberately bounded language contract. Unrecognized changes require clarification,
// rather than allowing the model to submit an arbitrary "closest" operation.
export function requestedEdits(instruction: string, clarification?: string): Request[] {
  function parse(text:string) {
    const requests:Request[]=[],unknown:string[]=[];
    const verbs=/(替换为|替换成|换为|换成|改为|改成|变为|变成|恢复成|添加|增加|外接|接上|加上|加一个|加|接一个|删除|删掉|\badd\b|\battach\b|\breplace\b|\bdelete\b|\bremove\b|\bchange\b)/gi;
    const clauses=text.split(/然后|并且|同时|接着|\bthen\b|\band\b|[，,；;\n]/i).map(s=>s.trim()).filter(Boolean);
    if(clauses.length>1)for(const clause of clauses){
      if(new RegExp(verbs.source,'i').test(clause))continue;
      if(/^(?:保留|保持|不改变|不修改|不移动|使用|采用|通过|keep\b|preserve\b|retain\b|using\b|with\b)/i.test(clause))continue;
      if(/^在[^，,；;\n]*(?:位置|连接点|选区|这里|此处|原子)(?:上)?$/.test(clause))continue;
      unknown.push(clause);
    }
    const matches=[...text.matchAll(verbs)];
    for(let i=0;i<matches.length;i++) {
      const verb=matches[i][0].toLowerCase(),start=matches[i].index!+matches[i][0].length;
      let target=text.slice(start,matches[i+1]?.index??text.length).split(/然后|并且|同时|[，,；;\n]/)[0].trim();
      if(/^(replace|change)$/.test(verb))target=target.split(/\s+(?:with|to)\s+/i).at(-1)!.replace(/^(?:with|to)\s+/i,'');
      if(/或者|还是|\bor\b/i.test(target)){unknown.push(target);continue;}
      if(/删除|删掉|delete|remove/.test(verb)){requests.push({operation:'delete_selection'});continue;}
      const order=cleanTarget(target).match(/^(?:这根.*)?(单|双|三)键|^(single|double|triple)\s+bond/i);
      if(order){const name=order[1]||order[2].toLowerCase();requests.push({operation:'change_bond',bondType:{单:1,双:2,三:3,single:1,double:2,triple:3}[name]});continue;}
      const adding=/添加|增加|外接|接上|加上|加一个|^加$|接一个|add|attach/.test(verb);
      const fragment=namedFragment(target),atom=adding?undefined:element(target);
      const operation=adding?'attach_fragment':atom?'replace_atom':'replace_fragment';
      requests.push({operation,...(fragment&&!atom?{fragment}:{}),...(atom?{element:atom}:{})});
      if(!fragment&&!atom)unknown.push(target);
    }
    return {requests,unknown};
  }
  let result=parse(instruction);
  if(clarification) {
    const reply=parse(clarification);
    if(reply.requests.length)result=reply;
    else {
      const fragment=namedFragment(clarification);
      if(fragment&&result.requests.length===1&&['attach_fragment','replace_fragment'].includes(result.requests[0].operation))result={requests:[{operation:result.requests[0].operation,fragment}],unknown:[]};
      else if(/^(?:只做第一步|只做前半部分)[。.!！\s]*$/.test(clarification)&&result.requests.length>1)result={requests:[result.requests[0]],unknown:result.unknown.length?[result.unknown[0]]:[]};
    }
  }
  if(result.unknown.length||!result.requests.length) {
    if(result.unknown.some(x=>/^C3H7\b/i.test(cleanTarget(x))))fail('ambiguous_fragment','请明确要正丙基还是异丙基；可在聊天补充后继续此批注。');
    fail('clarification_required','无法核对完整修改要求，请明确添加或替换的基团、元素或键级。不会生成替代操作或只做一半。');
  }
  return result.requests;
}
export function verifyEditIntent(instruction: string,patch: any,clarification?: string) {
  const expected=requestedEdits(instruction,clarification),actual=patch.operation==='batch'?patch.edits:[patch];
  if(expected.length!==actual.length)fail('incomplete_edit',`完整要求有 ${expected.length} 步，修改计划只有 ${actual.length} 步。请一次提交完整计划；只做部分需要用户明确确认。`);
  expected.forEach((request,i)=>{
    const edit=actual[i];
    if(request.operation!==edit.operation||request.fragment&&request.fragment!==edit.fragment||request.element&&request.element!==edit.element||request.bondType&&request.bondType!==edit.bondType)
      fail('intent_mismatch',`第 ${i+1} 步与用户要求不一致，已拒绝。不能将丙基换成甲基、把替换当添加，或提交未经确认的替代操作。`);
  });
  return expected;
}
