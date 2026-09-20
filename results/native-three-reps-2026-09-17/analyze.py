"""Read-only evidence verification and descriptive summary; never rewrites run artifacts."""
import hashlib,json,pathlib,collections
root=pathlib.Path(__file__).resolve().parent
records=json.loads((root/'progress.json').read_text())
rows=[]
for record in records:
 p=pathlib.Path(record['dir'])
 s=json.loads((p/'summary.json').read_text())
 mismatches=[]
 for manifest in ['integrity.json','result-receipt.json']:
  data=json.loads((p/manifest).read_text())
  for filename,digest in data.get('hashes',data).items():
   if hashlib.sha256((p/filename).read_bytes()).hexdigest()!=digest:mismatches.append(filename)
 models=collections.Counter();bad=[];internal=[]
 for number,line in enumerate((p/'claude-code.jsonl').open(),1):
  try:event=json.loads(line)
  except json.JSONDecodeError:bad.append(number);continue
  if event.get('type')=='assistant':models[event.get('message',{}).get('model','unknown')]+=1
  if event.get('type')=='result':internal=list(event.get('modelUsage',{}))
 final=s['evidence']['final'];checks=final['focal']+final['hotfix']
 events=s['grade']['events']
 rows.append(dict(id=record['id'],directory=str(p.relative_to(root.parent.parent)),model=record['model'],family=record['family'],repetition=record['rep'],seed=record['seed'],reused=bool(record['reused']),termination=s['termination'],valid=s['grade']['valid'],censored=s['grade']['censored'],checksPassed=sum(c['passed'] for c in checks),checksTotal=len(checks),failedChecks=[c for c in checks if not c['passed']],eventsFired=sum(e['fired'] for e in events),eventsRetrieved=sum(e.get('observation',{}).get('contentRetrieved',False) for e in events),eventDetails=[{k:e.get(k) for k in ['kind','firedDecision','trigger','contentDecision','focalChecksFailingAtFire','adapted']} for e in events],decisions=s['usage']['turnCalls'],minutes=round(s['durationMs']/60000,2),estimatedCostUsd=s['usage']['costUsd']['total'],mainModelRecords=dict(models),internalModels=internal,malformedSDKLines=bad,hashMismatches=mismatches))
(root/'analysis.json').write_text(json.dumps(rows,indent=2)+'\n')
print('Complete records:',len(rows))
for r in rows:print(r['id'],r['termination']['reason'],str(r['checksPassed'])+'/'+str(r['checksTotal']),str(r['eventsRetrieved'])+'/'+str(r['eventsFired']),'hash mismatches',len(r['hashMismatches']),'malformed SDK records',len(r['malformedSDKLines']))
