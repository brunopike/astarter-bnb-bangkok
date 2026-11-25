import {ROLES} from './simulation.mjs';
// Routing plans only. Catalog identities checked against the provider registry on 2026-11-03.
export const AGENT_MODEL_CATALOG=Object.freeze([
 {
  "id": "openai/gpt-6.1-sol",
  "family": "sol",
  "familyName": "GPT Sol",
  "name": "GPT-6.1 Sol",
  "version": "openai/gpt-6.1-sol-20260929"
 },
 {
  "id": "openai/gpt-6-sol",
  "family": "sol",
  "familyName": "GPT Sol",
  "name": "GPT-6 Sol",
  "version": "openai/gpt-6-sol-20260922"
 },
 {
  "id": "openai/gpt-6.1-terra",
  "family": "terra",
  "familyName": "GPT Terra",
  "name": "GPT-6.1 Terra",
  "version": "openai/gpt-6.1-terra-20261026"
 },
 {
  "id": "openai/gpt-6-luna",
  "family": "luna",
  "familyName": "GPT Luna",
  "name": "GPT-6 Luna",
  "version": "openai/gpt-6-luna-20260922"
 },
 {
  "id": "openai/gpt-6-astra",
  "family": "astra",
  "familyName": "GPT Astra",
  "name": "GPT-6 Astra",
  "version": "openai/gpt-6-astra-20260903"
 },
 {
  "id": "anthropic/claude-sonnet-5.5",
  "family": "sonnet",
  "familyName": "Claude Sonnet",
  "name": "Claude Sonnet 5.5",
  "version": "anthropic/claude-sonnet-5.5-20260928"
 },
 {
  "id": "anthropic/claude-sonnet-5",
  "family": "sonnet",
  "familyName": "Claude Sonnet",
  "name": "Claude Sonnet 5",
  "version": "anthropic/claude-sonnet-5-20260630"
 },
 {
  "id": "anthropic/claude-sonnet-4.6",
  "family": "sonnet",
  "familyName": "Claude Sonnet",
  "name": "Claude Sonnet 4.6",
  "version": "anthropic/claude-4.6-sonnet-20260217"
 },
 {
  "id": "google/gemini-3.8-flash",
  "family": "gemini",
  "familyName": "Gemini Flash",
  "name": "Gemini 3.8 Flash",
  "version": "google/gemini-3.8-flash-20260902"
 },
 {
  "id": "google/gemini-3.7-flash",
  "family": "gemini",
  "familyName": "Gemini Flash",
  "name": "Gemini 3.7 Flash",
  "version": "google/gemini-3.7-flash-20260813"
 },
 {
  "id": "google/gemini-3.6-flash",
  "family": "gemini",
  "familyName": "Gemini Flash",
  "name": "Gemini 3.6 Flash",
  "version": "google/gemini-3.6-flash-20260721"
 }
]);

export const AGENT_MODEL_FAMILIES=[...new Map(AGENT_MODEL_CATALOG.map(m=>[m.family,{id:m.family,name:m.familyName}])).values()];
const presets={
 balanced:[8,0,5,2,3,8,0,5,5,4,3,0,4,0,4,2,3,5],
 fast:[3,2,8,3,8,3,2,0,0,2,3,2,0,2,0,3,3,2],
 adaptive:[8,2,0,8,3,8,0,5,5,4,3,0,4,2,4,2,3,5]
};
const route=m=>({model:m.id,version:m.version});
export const safeModelIdentity=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value)&&! /^(?:sk[-_]|rk[-_]|AIza|gh[pousr]_|Bearer)/.test(value)&&! /^[a-f0-9]{64}$/i.test(value);
export function officialAgentModels(mode='balanced'){
 const selected=presets[mode]||presets.balanced;
 return Object.fromEntries(ROLES.map((role,index)=>[role.id,route(AGENT_MODEL_CATALOG[selected[index]])]));
}
export function normalizeAgentModels(value,legacyModel=''){
 const defaults=officialAgentModels();
 return Object.fromEntries(ROLES.map(role=>{
  const item=value?.[role.id];
  if(item&&typeof item==='object')return [role.id,{model:safeModelIdentity(item.model)?item.model:'',version:safeModelIdentity(item.version)?item.version:''}];
  return [role.id,safeModelIdentity(legacyModel)?{model:legacyModel,version:''}:defaults[role.id]];
 }));
}
export const catalogModel=assignment=>AGENT_MODEL_CATALOG.find(m=>m.id===assignment?.model&&m.version===assignment?.version)||null;
export function agentModelPlan(ai={}){
 ai=ai&&typeof ai==='object'?ai:{};
 const source=ai.source==='custom'?'custom':'official',mode=Object.hasOwn(presets,ai.model)?ai.model:'balanced';
 return {source,mode,assignments:source==='official'?officialAgentModels(mode):normalizeAgentModels(ai.agents,ai.modelId)};
}
export function agentModelsIssue(ai){
 if(ai?.source!=='custom')return null;
 const models=agentModelPlan(ai).assignments;
 return ROLES.find(role=>!safeModelIdentity(models[role.id]?.model)||!safeModelIdentity(models[role.id]?.version))?.id||null;
}
