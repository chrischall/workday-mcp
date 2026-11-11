// Shapes captured live (2026-11-11) from the three feedback grids on a worker
// profile, names and text replaced. What matters is the structure:
//
// - Each grid nests a `columnGroup`. A row that starts a new item carries
//   every column; the rows after it carry ONLY the group's columns, and
//   belong to the item above them.
// - Feedback Requested's request column has no label (only a propertyName),
//   and its responder ("From") is a `fieldSet` wrapping a monikerList.
// - Rich text arrives as HTML, lists included.

const page = (grid: Record<string, unknown>) => ({
  widget: 'root',
  title: 'Pat Doe',
  body: { widget: 'vbox', children: [grid] },
});

const responder = (id: string, name: string) => ({
  widget: 'fieldSet',
  children: [
    {
      widget: 'monikerList',
      instances: [{ widget: 'moniker', instanceId: id, text: name, action: 'person' }],
      selfUriTemplate: `/acme/inst/15$143211/${id}`,
      singular: true,
      propertyName: 'wd:Responder_from_Give_Feedback_Event_for_Feedback_Response--IS',
    },
    { widget: 'imageList', propertyName: 'wd:Photo_for_Role--IS' },
  ],
  layoutInstanceId: '1599$10101',
});

const rich = (label: string, html?: string) => ({
  widget: 'compactRichTextArea',
  label,
  ...(html !== undefined ? { value: html } : {}),
});
const check = (label: string, yes: boolean) => ({ widget: 'checkBox', label, value: yes, text: yes ? 'Yes' : 'No' });

const request = (iid: string, text: string) => ({
  widget: 'monikerList',
  instances: [{ widget: 'moniker', instanceId: iid, text }],
  selfUriTemplate: `/acme/inst/1$9734/${iid}`,
  singular: true,
  propertyName: 'wd:Feedback_Requested--IS',
});

const questionRow = (
  i: number,
  req: { iid: string; text: string },
  question: string,
  date: string,
  from: { id: string; name: string },
  feedback: string | undefined,
  shareLabel: string,
  shared: boolean
) => ({
  widget: 'row',
  rowIndex: i,
  cellsMap: {
    '102.1': request(req.iid, req.text),
    '102.2': rich('Question', `<p>${question}</p>`),
    '102.4': { widget: 'text', label: 'Status', value: 'In Progress' },
    '102.5': { widget: 'date', label: 'Request Date', value: { V: date }, text: date },
    '102.6': { widget: 'commandButton', label: 'Ask Others', uri: '/acme/button/x/1', httpMethod: 'POST' },
    '96.2': responder(from.id, from.name),
    '96.4': rich('Feedback', feedback),
    '96.7': check(shareLabel, shared),
  },
});

const answerRow = (i: number, from: { id: string; name: string }, feedback: string | undefined, shareLabel: string, shared: boolean) => ({
  widget: 'row',
  rowIndex: i,
  cellsMap: {
    '96.2': responder(from.id, from.name),
    '96.4': rich('Feedback', feedback),
    '96.7': check(shareLabel, shared),
  },
});

const SAM = { id: '247$1', name: 'Sam Roe' };
const LEE = { id: '247$2', name: 'Lee Ray' };
const KIM = { id: '247$3', name: 'Kim Fox' };
const PRIVATE = 'Private: Shared with Feedback Recipient';
const MINE = { iid: '9735$1', text: 'Feedback Request: Pat Doe requested by Pat Doe' };
const OTHER = { iid: '9735$2', text: 'Feedback Request: Pat Doe requested by Pat Doe' };

export const requestedPage = page({
  widget: 'grid',
  label: 'Feedback Requested',
  rowCount: 4,
  deepRowCount: 6,
  columns: [
    { widget: 'column', columnId: '102.1', propertyName: 'wd:Feedback_Requested--IS' },
    { widget: 'column', columnId: '102.2', label: 'Question' },
    { widget: 'column', columnId: '102.4', label: 'Status' },
    { widget: 'column', columnId: '102.5', label: 'Request Date' },
    { widget: 'column', columnId: '102.6', propertyName: 'wd:Ask_Others' },
    {
      widget: 'columnGroup',
      columnId: '102.7',
      propertyName: 'wd:Feedback_Response_from_Request_View',
      columns: [
        { widget: 'column', columnId: '96.2', label: 'From' },
        { widget: 'column', columnId: '96.4', label: 'Feedback' },
        { widget: 'column', columnId: '96.7', label: PRIVATE },
      ],
    },
  ],
  rows: [
    // Request 1, asked of Sam and Lee: Lee has answered both questions.
    questionRow(1, MINE, 'How am I doing?', '11/10/2026', SAM, undefined, PRIVATE, true),
    answerRow(2, LEE, '<p>You are doing <strong>great</strong>.</p>', PRIVATE, true),
    questionRow(3, MINE, 'What should I keep doing?', '11/10/2026', SAM, undefined, PRIVATE, true),
    answerRow(4, LEE, '<ul><li>Unblocking us</li><li>Being <em>approachable</em></li></ul>', PRIVATE, true),
    // Request 2, the same day and the same label, asked of Kim alone: open.
    questionRow(5, OTHER, 'What could I do better?', '11/10/2026', KIM, undefined, PRIVATE, false),
    // An old request whose response row is empty.
    questionRow(6, { iid: '9735$3', text: 'Feedback Request: Pat Doe requested by Pat Doe' }, 'Anything else?', '08/20/2025', LEE, '<p>All good, see <a href="https://example.com/doc">the doc</a>.</p>', PRIVATE, false),
  ],
});

export const receivedPage = page({
  widget: 'grid',
  rowCount: 2,
  deepRowCount: 3,
  columns: [
    { widget: 'column', columnId: '148.1', label: 'Date' },
    { widget: 'column', columnId: '148.2', label: 'Photo' },
    { widget: 'column', columnId: '148.3', label: 'From' },
    {
      widget: 'columnGroup',
      columnId: '148.5',
      label: 'Feedback Received',
      columns: [
        { widget: 'column', columnId: '124.1', label: 'Question' },
        { widget: 'column', columnId: '124.2', label: 'Feedback' },
      ],
    },
    { widget: 'column', columnId: '148.6', label: 'Type' },
    { widget: 'column', columnId: '148.7', label: PRIVATE },
  ],
  rows: [
    {
      widget: 'row',
      rowIndex: 1,
      cellsMap: {
        '148.1': { widget: 'date', label: 'Date', value: { V: '11/11/2026' }, text: '11/11/2026' },
        '148.2': { widget: 'imageList', label: 'Photo' },
        '148.3': { widget: 'text', label: 'From', value: 'Lee Ray' },
        '148.6': { widget: 'text', label: 'Type', value: 'Requested by Self' },
        '148.7': check(PRIVATE, true),
        '124.1': rich('Question', '<p>How am I doing?</p>'),
        '124.2': rich('Feedback', '<p>You are doing <strong>great</strong>.</p>'),
      },
    },
    {
      widget: 'row',
      rowIndex: 2,
      cellsMap: {
        '124.1': rich('Question', '<p>What should I keep doing?</p>'),
        '124.2': rich('Feedback', '<ul><li>Unblocking us</li><li>Being <em>approachable</em></li></ul>'),
      },
    },
    {
      widget: 'row',
      rowIndex: 3,
      cellsMap: {
        '148.1': { widget: 'date', label: 'Date', value: { V: '01/02/2024' }, text: '01/02/2024' },
        '148.3': { widget: 'text', label: 'From', value: 'Kim Fox' },
        '148.6': { widget: 'text', label: 'Type', value: 'Unsolicited' },
        '148.7': check(PRIVATE, false),
        '124.2': rich('Feedback', '<p>Thanks for the help!</p>'),
      },
    },
  ],
});

// When every request on a page went to ONE person (live: a confidential
// request about one report, asked of one colleague, 2026-11-11), Workday
// drops the columnGroup: From, Feedback and visibility are plain columns.
const CONFIDENTIAL = 'Confidential: Not Shared with Feedback Recipient';
const flatRow = (i: number, question: string, feedback?: string) => ({
  widget: 'row',
  rowIndex: i,
  cellsMap: {
    '102.1': request('9735$7', 'Feedback Request: Sam Roe requested by Pat Doe'),
    '102.2': rich('Question', `<p>${question}</p>`),
    '102.4': { widget: 'text', label: 'Status', value: 'In Progress' },
    '102.5': { widget: 'date', label: 'Request Date', value: { V: '11/10/2026' }, text: '11/10/2026' },
    '102.8': responder(KIM.id, KIM.name),
    '102.10': rich('Feedback', feedback),
    '102.12': check(CONFIDENTIAL, true),
  },
});
export const requestedFlatPage = page({
  widget: 'grid',
  label: 'Feedback Requested',
  rowCount: 2,
  deepRowCount: 2,
  columns: [
    { widget: 'column', columnId: '102.1', propertyName: 'wd:Feedback_Requested--IS' },
    { widget: 'column', columnId: '102.2', label: 'Question' },
    { widget: 'column', columnId: '102.4', label: 'Status' },
    { widget: 'column', columnId: '102.5', label: 'Request Date' },
    { widget: 'column', columnId: '102.8', label: 'From' },
    { widget: 'column', columnId: '102.10', label: 'Feedback' },
    { widget: 'column', columnId: '102.12', label: CONFIDENTIAL },
  ],
  rows: [flatRow(1, 'How has Sam done?'), flatRow(2, 'What should Sam keep doing?', '<p>Shipping on time.</p>')],
});
