/** Extensia moddle pentru atributele SeaDoc din docs/API.md. */
export const seadocDescriptor = {
  name: 'SeaDoc',
  uri: 'http://seadoc.ro/schema/bpmn',
  prefix: 'seadoc',
  xml: { tagAlias: 'lowerCase' },
  associations: [],
  types: [
    {
      name: 'UserTaskAttributes',
      extends: ['bpmn:UserTask'],
      properties: [
        { name: 'assigneeType', isAttr: true, type: 'String' },
        { name: 'assignee', isAttr: true, type: 'String' },
        { name: 'action', isAttr: true, type: 'String' },
        { name: 'dueHours', isAttr: true, type: 'String' },
        { name: 'completion', isAttr: true, type: 'String' },
      ],
    },
    {
      name: 'SequenceFlowAttributes',
      extends: ['bpmn:SequenceFlow'],
      properties: [{ name: 'condition', isAttr: true, type: 'String' }],
    },
  ],
};

export const moddleExtensions = { seadoc: seadocDescriptor };

export const NEW_DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:seadoc="http://seadoc.ro/schema/bpmn" id="Definitions_1" targetNamespace="http://seadoc.ro/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Start">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:endEvent id="EndEvent_1" name="Final">
      <bpmn:incoming>Flow_1</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="EndEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="180" y="142" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="168" y="185" width="60" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1">
        <dc:Bounds x="520" y="142" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="508" y="185" width="60" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="216" y="160" />
        <di:waypoint x="520" y="160" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
