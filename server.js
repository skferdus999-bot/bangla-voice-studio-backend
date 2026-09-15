const express=require("express");
const app=express(); app.use(express.json({limit:"1mb"}));
const PORT=process.env.PORT||8080, KEY=process.env.ELEVENLABS_API_KEY;
const MODEL=process.env.ELEVENLABS_MODEL||"eleven_multilingual_v2";
const voices={
 bn:{FEMALE:process.env.BN_FEMALE_VOICE_ID||"",MALE:process.env.BN_MALE_VOICE_ID||""},
 hi:{FEMALE:process.env.HI_FEMALE_VOICE_ID||"",MALE:process.env.HI_MALE_VOICE_ID||""},
 en:{FEMALE:process.env.EN_FEMALE_VOICE_ID||"",MALE:process.env.EN_MALE_VOICE_ID||""},
 ur:{FEMALE:process.env.UR_FEMALE_VOICE_ID||"",MALE:process.env.UR_MALE_VOICE_ID||""}
};
app.get("/health",(q,s)=>s.json({ok:true,service:"Bangla Voice Studio - ElevenLabs"}));
app.post("/tts",async(q,s)=>{
 try{
  if(!KEY)return s.status(500).json({error:"ELEVENLABS_API_KEY is not configured"});
  const {text,language="bn",voiceGender="FEMALE",speed=1}=q.body||{};
  const id=(voices[language]||{})[voiceGender]||"";
  if(!text)return s.status(400).json({error:"text is required"});
  if(!id)return s.status(400).json({error:`No voice ID configured for ${language}/${voiceGender}`});
  const u=`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`;
  const r=await fetch(u,{method:"POST",headers:{"xi-api-key":KEY,"Content-Type":"application/json"},body:JSON.stringify({text,model_id:MODEL,voice_settings:{speed:Number(speed)||1}})});
  const b=Buffer.from(await r.arrayBuffer());
  if(!r.ok)return s.status(r.status).send(b.toString("utf8"));
  s.json({audioContent:b.toString("base64"),voiceId:id,model:MODEL});
 }catch(e){s.status(500).json({error:e.message})}
});
app.listen(PORT,()=>console.log("ElevenLabs backend listening on "+PORT));
