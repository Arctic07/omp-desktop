import { Download, RefreshCw } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'

import { Button } from '@/components/motion/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { useCopy } from '@/lib/i18n'
import { MODELS_COPY } from '@/settings/sections/models/copy'
import CustomPanel from '@/settings/sections/models/CustomPanel'
import { ModelsStatus } from '@/settings/sections/models/panel-state'
import ProvidersPanel from '@/settings/sections/models/ProvidersPanel'
import RolesPanel from '@/settings/sections/models/RolesPanel'
import { loadModels, modelStore } from '@/state/model-store'
import { ompImportStore, openOmpImport } from '@/state/omp-import-store'
import { useStoreSelector } from '@/state/store'

/**
 * The model page has three separate configuration views. Their order is intentional: the role
 * table answers which model does what, the built-in providers supply credentials for those models,
 * and custom providers are the final extension point.
 *
 * The page reads the engine's model configuration once, on arrival, and the refresh beside the tab
 * bar is the one way to ask for it again — the views below share that read.
 */
type ModelsTab = 'roles' | 'providers' | 'custom'

interface ModelTabDefinition {
  id: ModelsTab
  tabId: string
  panelId: string
}

const MODEL_TABS: readonly ModelTabDefinition[] = [
  { id: 'roles', tabId: 'models-tab-roles', panelId: 'models-panel-roles' },
  { id: 'providers', tabId: 'models-tab-providers', panelId: 'models-panel-providers' },
  { id: 'custom', tabId: 'models-tab-custom', panelId: 'models-panel-custom' },
]

const MODEL_PANELS: Readonly<Record<ModelsTab, ComponentType>> = {
  roles: RolesPanel,
  providers: ProvidersPanel,
  custom: CustomPanel,
}

function isModelsTab(value: string): value is ModelsTab {
  return MODEL_TABS.some((tab) => tab.id === value)
}

export default function ModelsSection() {
  const copy = useCopy(MODELS_COPY)
  const [tab, setTab] = useState<ModelsTab>('roles')
  const status = useStoreSelector(modelStore, (state) => state.status)
  const labels: Record<ModelsTab, string> = {
    roles: copy.rolesTabLabel,
    providers: copy.providersTabLabel,
    custom: copy.customTabLabel,
  }

  // The section is mounted per visit, so this is the page's own read: it loads all six lists at once.
  useEffect(() => {
    void loadModels()
  }, [])

  // An import changes the catalogue this page is showing - roles, providers, their keys - so the
  // page re-reads it when the dialog reports that something landed. Nothing else on this page can
  // change what the engine offers without a refresh button press.
  const imported = useStoreSelector(ompImportStore, (state) => state.result)
  useEffect(() => {
    if (imported === null) return
    void loadModels(true)
  }, [imported])

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isModelsTab(value)) {
          setTab(value)
        }
      }}
      variant="segment"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <TabsList aria-label={copy.tabsLabel}>
            {MODEL_TABS.map((definition) => (
              <TabsTrigger
                key={definition.id}
                id={definition.tabId}
                value={definition.id}
                aria-controls={definition.panelId}
              >
                {labels[definition.id]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="flex-none"
          title={copy.importHint}
          onClick={() => void openOmpImport('manual')}
        >
          <Download size={14} aria-hidden="true" />
          {copy.importLabel}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-none"
          disabled={status === 'loading'}
          title={copy.refreshModelsHint}
          onClick={() => void loadModels(true)}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {status === 'loading' ? copy.refreshingModels : copy.refreshModels}
        </Button>
      </div>

      <ModelsStatus />

      {MODEL_TABS.map((definition) => {
        const Panel = MODEL_PANELS[definition.id]
        return (
          <TabsContent key={definition.id} value={definition.id}>
            <section
              id={definition.panelId}
              role="tabpanel"
              aria-labelledby={definition.tabId}
              className="flex flex-col gap-7"
            >
              <Panel />
            </section>
          </TabsContent>
        )
      })}
    </Tabs>
  )
}
