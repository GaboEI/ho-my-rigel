// Clasificacion de las superficies de `packages/omo-opencode/src/agents/`
// para el espejo nativo V2. Consumido por generate-v2-migration-inventory.mjs.
// Cada entrada: { classification, rationale, futureEvidence }.
export default {
  "agent-builder": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "agent-builder.ts compone el AgentConfig con buildAgent a partir de factories y overrides de categoria durante la generacion, y su salida queda horneada en el manifiesto V2 sin superficie de runtime propia.",
    futureEvidence: "contract:rigel-v2-native-agents.test.mjs",
  },
  "agent-skill-resolution": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "agent-skill-resolution.ts resuelve las skills declaradas por el agente e inserta su contenido en el prompt al armar la configuracion, por lo que solo actua en la generacion del manifiesto.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  atlas: {
    classification: "Migrar",
    rationale:
      "atlas/agent.ts define el orquestador primario, sus prompts por modelo y su modo; el manifiesto nativo y rigel-v2-native-agents.mjs deben registrar su roster y su modo no delegable.",
    futureEvidence: "task:12",
  },
  "builtin-agents": {
    classification: "Migrar",
    rationale:
      "builtin-agents/ contiene las factorias condicionales que arman el roster y aplican overrides, resolucion de modelo y permisos antes de escribir el manifiesto, incluido el gate de Hephaestus, por lo que su efecto debe reproducirse en V2.",
    futureEvidence: "task:13",
  },
  "dynamic-agent-category-skills-guide": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "dynamic-agent-category-skills-guide.ts ensambla las secciones de guia de categorias y skills del prompt de Sisyphus en tiempo de generacion y no tiene superficie de runtime.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "dynamic-agent-core-sections": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "dynamic-agent-core-sections.ts arma las secciones base del prompt, desde identidad hasta tablas de delegacion, durante la generacion del agente.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "dynamic-agent-policy-sections": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "dynamic-agent-policy-sections.ts arma las secciones de politicas y bloques duros del prompt en tiempo de generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "dynamic-agent-prompt-builder": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "dynamic-agent-prompt-builder.ts es un barrel que reexporta los constructores de secciones y solo participa en el armado del prompt de generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "dynamic-agent-prompt-types": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "dynamic-agent-prompt-types.ts define los tipos de las secciones dinamicas del prompt y no aporta comportamiento de runtime.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "dynamic-agent-tool-categorization": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "dynamic-agent-tool-categorization.ts clasifica herramientas para el prompt de generacion y no expone superficie de runtime.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "env-context": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "env-context.ts produce el bloque de timezone y locale que se anexa al prompt al generar la configuracion, por lo que su valor queda horneado en el manifiesto.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  explore: {
    classification: "Migrar",
    rationale:
      "explore.ts define el subagente de busqueda con sus restricciones de herramientas y metadatos; el manifiesto V2 debe incluir su definicion y su cadena de fallback.",
    futureEvidence: "task:8",
  },
  "frontier-tool-schema-guard": {
    classification: "Adaptar",
    rationale:
      "frontier-tool-schema-guard.ts niega grep y glob para modelos frontier; en V2 debe adaptarse al vocabulario de acciones y recursos del modelo de permisos de AgentV2Info.",
    futureEvidence: "task:10",
  },
  "gpt-apply-patch-guard": {
    classification: "Adaptar",
    rationale:
      "gpt-apply-patch-guard.ts solo aporta guias de edicion para modelos GPT; en V2 la guia se adapta a la frontera de herramientas de edicion disponible.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "gpt-prompt-identity": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "gpt-prompt-identity.ts mapea el modelo a la identidad textual usada por los prompts de Sisyphus y Sisyphus-Junior en tiempo de generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  hephaestus: {
    classification: "Migrar",
    rationale:
      "hephaestus/agent.ts define el agente autonomo primario y su gate de modelo soportado; el roster nativo debe restaurarlo con el gate de proveedor sobre el manifiesto.",
    futureEvidence: "task:11",
  },
  "kimi-tool-loop-guard": {
    classification: "Migrar",
    rationale:
      "kimi-tool-loop-guard.ts es una guia textual que evita llamadas repetidas; se migra como parte del prompt del agente hacia la frontera de herramientas V2.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  librarian: {
    classification: "Migrar",
    rationale:
      "librarian.ts define el subagente de busqueda externa con sus restricciones; su definicion y su cadena de fallback deben portarse al manifiesto nativo.",
    futureEvidence: "task:8",
  },
  metis: {
    classification: "Migrar",
    rationale:
      "metis.ts define el consultor de pre-planificacion con prompts por modelo y restricciones; el manifiesto nativo debe portar su definicion y fallback.",
    futureEvidence: "task:8",
  },
  momus: {
    classification: "Migrar",
    rationale:
      "momus.ts define el revisor de planes y selecciona el prompt segun el modelo; su definicion debe portarse al manifiesto nativo.",
    futureEvidence: "task:8",
  },
  "momus-gpt-5-6": {
    classification: "Migrar",
    rationale:
      "momus-gpt-5-6.ts es la variante de prompt GPT-5.6 consumida por momus.ts; la definicion de Momus en V2 debe conservar esa seleccion por modelo.",
    futureEvidence: "task:8",
  },
  "multimodal-looker": {
    classification: "Migrar",
    rationale:
      "multimodal-looker.ts define el subagente de analisis de medios con allowlist de solo lectura; el modelo de permisos V2 debe reproducir su bloqueo restrictivo.",
    futureEvidence: "task:10",
  },
  oracle: {
    classification: "Migrar",
    rationale:
      "oracle.ts define el consultor de solo lectura con prompts por modelo y su cadena de fallback; el manifiesto nativo debe portar la definicion.",
    futureEvidence: "task:8",
  },
  prometheus: {
    classification: "Migrar",
    rationale:
      "prometheus/system-prompt.ts carga el prompt del planificador y su permiso; el manifiesto V2 debe registrar su modo primary y su no delegabilidad.",
    futureEvidence: "task:12",
  },
  sisyphus: {
    classification: "Migrar",
    rationale:
      "sisyphus-agent-factory.ts y el directorio sisyphus/ seleccionan el prompt por modelo y arman el agente orquestador principal; su definicion debe portarse al manifiesto nativo.",
    futureEvidence: "task:8",
  },
  "sisyphus-agent-config": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-agent-config.ts construye las variantes de AgentConfig de Sisyphus por modelo en tiempo de generacion, sin superficie de runtime.",
    futureEvidence: "contract:rigel-v2-native-agents.test.mjs",
  },
  "sisyphus-agent-factory": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-agent-factory.ts enruta al prompt de Sisyphus segun el modelo y compone el AgentConfig durante la generacion del manifiesto.",
    futureEvidence: "contract:rigel-v2-native-agents.test.mjs",
  },
  "sisyphus-dynamic-prompt": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-dynamic-prompt.ts orquesta el armado dinamico del prompt de Sisyphus y aplica overrides de Gemini en tiempo de generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "sisyphus-dynamic-prompt-builder": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-dynamic-prompt-builder.ts encadena los renderizadores de secciones del prompt dinamico de Sisyphus durante la generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "sisyphus-dynamic-prompt-execution": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-dynamic-prompt-execution.ts renderiza la seccion de ejecucion y delegacion del prompt de Sisyphus durante la generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "sisyphus-dynamic-prompt-exploration": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-dynamic-prompt-exploration.ts renderiza la seccion de exploracion y busqueda paralela del prompt de Sisyphus en la generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "sisyphus-dynamic-prompt-role": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-dynamic-prompt-role.ts renderiza las secciones de rol e intent gate del prompt de Sisyphus en tiempo de generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "sisyphus-dynamic-prompt-sections": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-dynamic-prompt-sections.ts recolecta las secciones que arman el prompt de Sisyphus durante la generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "sisyphus-dynamic-prompt-style": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-dynamic-prompt-style.ts renderiza la seccion de tono y restricciones del prompt de Sisyphus durante la generacion.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "sisyphus-gemini-fallback-overrides": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "sisyphus-gemini-fallback-overrides.ts inserta overrides de Gemini en el prompt ya armado durante la generacion del agente.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "sisyphus-junior": {
    classification: "Migrar",
    rationale:
      "sisyphus-junior/agent.ts define el ejecutor por categoria con sus defaults y prompts por modelo; el manifiesto nativo debe llevar su maxTokens y su tuning al payload V2.",
    futureEvidence: "task:9",
  },
  "sisyphus-runtime-prompt-reconciler": {
    classification: "Migrar",
    rationale:
      "sisyphus-runtime-prompt-reconciler.ts reconstruye el prompt de Sisyphus por peticion cuando el modelo de runtime difiere del configurado y esta cableado en plugin/system-transform.ts, por lo que su comportamiento de runtime debe migrarse a la frontera de prompt V2.",
    futureEvidence: "task:8",
  },
}
