/**
 * Prepared native-review evidence for the restricted GHL contact-storage scope.
 * This is NOT an approval and records no reviewer. It is loaded into the existing review form by an
 * authenticated admin, compared against the live inventories, and submitted only by the owner after an explicit
 * acknowledgement. Never edit hashes to match a changed live value: a change must be inspected and a new package prepared.
 */
export interface PreparedWorkflowEvidence {
  workflowId: string;
  disposition: "reviewed_safe" | "no_native_triggers";
  evidenceReference: string;
  observedUpdatedAt: string;
  observedVersion: string;
  definitionHash: string;
  changeMetadata: string;
}

export interface PreparedNativeReview {
  source: string;
  attribution: string;
  scope: string;
  locationId: string;
  inventoryRevision: string;
  customFieldInventoryRevision: string;
  scopeRulesRevision: string;
  allowedOperations: Array<{
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    fields: string[];
    tags: string[];
    stageIds: string[];
    customFieldIds: string[];
    purpose: string;
    safetyEvidence: string;
  }>;
  workflowActionEvidence: PreparedWorkflowEvidence[];
}

export const PREPARED_NATIVE_REVIEW: PreparedNativeReview = {
  "source": "Independent GHL workflow definition inspection of 2026-10-24, retained in docs/ghl-native-safety-approval-package.md section 5 and carried into the published-build review report of 2026-10-25",
  "attribution": "independent_audit_2026_10_24",
  "scope": "Restricted contact-storage scope only: POST /contacts, PUT /contacts/:contactId, POST and DELETE /contacts/:contactId/tags. No messaging, workflow enrollment or promotion is covered.",
  "locationId": "BbcWy2xmyg4izLjlFfLQ",
  "inventoryRevision": "0a23603ea96b8821fdc4660a0cb5fdac55feff8ca7da751220c6298e9b006f1b",
  "customFieldInventoryRevision": "814549f1cdbbe19f1d9a4ff2d603ce9936e9bc0aa034b51130573dbef33ea943",
  "scopeRulesRevision": "adcb650d07538e0a1dec0ca47a2f538805b9ab39eabd60b38965c91bf3e2bc17",
  "allowedOperations": [
    {
      "method": "POST",
      "path": "/contacts",
      "fields": [
        "locationId",
        "firstName",
        "lastName",
        "email",
        "phone",
        "companyName",
        "customFields"
      ],
      "tags": [],
      "stageIds": [],
      "customFieldIds": [
        "Rfo6frTXZrzZtbUKsNN1",
        "CpXFAsahrrp9J837HHI1",
        "86igW42wnYpLVGMWADrj",
        "Rog35nsPLTFPa4A1UOJD",
        "k3gqyGYfAgTalYoYPa8P",
        "0rhXcXVAQCBxrFtPU5uY",
        "wMFGgmIS3puA0NjVnQO5",
        "aAUS7lQpK15mBGx0QAD6"
      ],
      "purpose": "Create a missing production contact identity with profile and suppression fields",
      "safetyEvidence": "Body carries no tags; no workflow id; native workflows do not trigger on these fields (approval package sections 3 and 5)"
    },
    {
      "method": "PUT",
      "path": "/contacts/:contactId",
      "fields": [
        "firstName",
        "lastName",
        "email",
        "phone",
        "companyName",
        "customFields"
      ],
      "tags": [],
      "stageIds": [],
      "customFieldIds": [
        "Rfo6frTXZrzZtbUKsNN1",
        "CpXFAsahrrp9J837HHI1",
        "86igW42wnYpLVGMWADrj",
        "Rog35nsPLTFPa4A1UOJD",
        "k3gqyGYfAgTalYoYPa8P",
        "0rhXcXVAQCBxrFtPU5uY",
        "wMFGgmIS3puA0NjVnQO5",
        "aAUS7lQpK15mBGx0QAD6"
      ],
      "purpose": "Update identity, profile, permission and suppression fields of a linked contact",
      "safetyEvidence": "Body carries no tags array and no workflow id; only reviewed field ids (approval package sections 1 and 3)"
    },
    {
      "method": "POST",
      "path": "/contacts/:contactId/tags",
      "fields": [
        "tags"
      ],
      "tags": [
        "LB-ACTIVE-PIPELINE",
        "lb_parent_account"
      ],
      "stageIds": [],
      "customFieldIds": [],
      "purpose": "Add the two CRM-owned tags only",
      "safetyEvidence": "Neither tag matches any inspected native workflow trigger (approval package sections 4 and 5)"
    },
    {
      "method": "DELETE",
      "path": "/contacts/:contactId/tags",
      "fields": [
        "tags"
      ],
      "tags": [
        "LB-ACTIVE-PIPELINE",
        "lb_parent_account"
      ],
      "stageIds": [],
      "customFieldIds": [],
      "purpose": "Remove the two CRM-owned tags only",
      "safetyEvidence": "Removal limited to the two owned tags; all GHL-owned tags are untouched (approval package section 4)"
    }
  ],
  "workflowActionEvidence": [
    {
      "workflowId": "8d572880-6db5-4931-8b18-087af46cec33",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T17:55:42.240Z",
      "observedVersion": "7",
      "definitionHash": "b69638868253f613f13e18de1402aca89d31098df01b91b7db2374be08787d61",
      "changeMetadata": "Observed draft, version 7. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "25b90839-ec70-4051-bf4e-8a27cdde54bb",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T15:07:57.070Z",
      "observedVersion": "3",
      "definitionHash": "d088c0e80f48330f27048e240c158484b17b180171be2ce05d6f0fc5ae8e4051",
      "changeMetadata": "Observed draft, version 3. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "8222ea04-fad5-433b-89bb-32834648b3f2",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-09T07:45:26.919Z",
      "observedVersion": "10",
      "definitionHash": "53840a9f7e9bb6669dd17ed27861efe9aee9e8167b3a474d1b74f755f351f98a",
      "changeMetadata": "Observed published, version 10. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "458caed6-6e40-4d1b-8453-511d1accbc13",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T15:05:06.902Z",
      "observedVersion": "5",
      "definitionHash": "3c1941cc27b6da1a1f5fab14a9cd7ffe18bba33a8e69748a75729414970c36e1",
      "changeMetadata": "Observed published, version 5. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "d21d0367-d626-41ae-ab43-3999cd0f7bca",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T15:05:09.056Z",
      "observedVersion": "23",
      "definitionHash": "46a1bfbfad8eaa364177a3cf1b95fd23768f6e0a61361c436d94f0b2a18e3c8a",
      "changeMetadata": "Observed published, version 23. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "336b720f-77af-4e3c-8d32-1570c0859916",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-09T07:46:00.722Z",
      "observedVersion": "12",
      "definitionHash": "69db34c1f458ff638d42730006428b3e6f4d71fd44b1e6a8e55fc3e5e4230c54",
      "changeMetadata": "Observed published, version 12. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "457b5bb0-5c1e-4fe3-a5fa-9cbbc7e10a0b",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T18:04:27.907Z",
      "observedVersion": "3",
      "definitionHash": "4e96a15e31de9c255d18e350284eafc731cafcd199a71e4462121128cecf7653",
      "changeMetadata": "Observed draft, version 3. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "40cd3463-febf-4e50-8603-115e8c89a562",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T15:05:14.505Z",
      "observedVersion": "6",
      "definitionHash": "28935119d39d6c83156159446c0bc19d50ac3118acac3297bd651212c14a1839",
      "changeMetadata": "Observed draft, version 6. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "43d0ae09-1fd6-4989-8dd3-84ad252a3c2e",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T18:35:56.452Z",
      "observedVersion": "2",
      "definitionHash": "bce5e92545d9b717f19c90d3d60ae094d925b8d34b8cf0763d14e6802612d54b",
      "changeMetadata": "Observed draft, version 2. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "667a50e4-39eb-42db-8ff9-809dba28bcd4",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T15:08:39.797Z",
      "observedVersion": "4",
      "definitionHash": "596d0c2f38598cbc733ca02c56e9acb516290c060853ebeebaa59e7fd5dae6c8",
      "changeMetadata": "Observed draft, version 4. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "73837dce-dfe5-4081-a02d-a4bc92a18f2e",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T15:08:18.448Z",
      "observedVersion": "3",
      "definitionHash": "773c17211c76bcbf92d505cf3c84bbfd7435055bd8224657888ec2dbc009267e",
      "changeMetadata": "Observed draft, version 3. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "02cbb528-c425-47cd-a5b8-b8ee71951048",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-10T19:39:29.427Z",
      "observedVersion": "10",
      "definitionHash": "18a494eefa06e543d5a2f85369bc7fc196095010e54a3cd11b6272f478acff44",
      "changeMetadata": "Observed draft, version 10. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "d86d18fc-0c8e-4967-bec9-842047d332e7",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T15:05:44.361Z",
      "observedVersion": "4",
      "definitionHash": "904ce0acda23b3e42eab58cb655284b54032cf5b752efe44aba0b611c8870d24",
      "changeMetadata": "Observed published, version 4. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    },
    {
      "workflowId": "49796144-fb74-4247-90b3-ecd08f813a04",
      "disposition": "reviewed_safe",
      "evidenceReference": "Independent GHL inspection 2026-10-24; docs/ghl-native-safety-approval-package.md section 5; restricted contact projection only",
      "observedUpdatedAt": "2026-10-08T15:05:46.233Z",
      "observedVersion": "9",
      "definitionHash": "84eee441383fc34130ff68c882d142a3a4f05df7be2fce6b43fde51fa9f23f91",
      "changeMetadata": "Observed published, version 9. Contact create/profile/suppression and the two owned tags do not match the inspected trigger. Confirm current metadata still matches; messaging is not approved."
    }
  ]
};
