// Re-ranks spelling suggestions. nspell's own order is weak ("teh" -> "ten"),
// so we prefer known typo fixes, then the smallest edit distance, then common
// English words.

import { COMMON_WORDS } from './common-words'

const RANK = new Map<string, number>(COMMON_WORDS.map((w, i) => [w, i]))
export function isCommon(word: string): boolean { return RANK.has(word.toLowerCase()) }
export function commonRank(word: string): number { const r = RANK.get(word.toLowerCase()); return r === undefined ? Infinity : r }

const TYPOS: Record<string, string> = {
  teh: 'the', hte: 'the', dosent: "doesn't", "dosen't": "doesn't", doesent: "doesn't", dont: "don't",
  wasent: "wasn't", isent: "isn't", wouldent: "wouldn't", couldent: "couldn't", shouldent: "shouldn't",
  havent: "haven't", hasent: "hasn't", didint: "didn't", wnat: 'want', waht: 'what', whta: 'what',
  hwo: 'how', hwat: 'what', yuo: 'you', yuor: 'your', jsut: 'just', liek: 'like', tihnk: 'think',
  thign: 'thing', thigns: 'things', mkae: 'make', amke: 'make', chnage: 'change', becuse: 'because',
  becaus: 'because', funciton: 'function', fucntion: 'function', funtion: 'function', retrun: 'return',
  lenght: 'length', widht: 'width', heigth: 'height', seperately: 'separately', occurance: 'occurrence',
  recieving: 'receiving', beggining: 'beginning', coment: 'comment', comit: 'commit', comitted: 'committed',
  commited: 'committed', databse: 'database', dependancy: 'dependency', dependancies: 'dependencies',
  enviornment: 'environment', excecute: 'execute', exmaple: 'example', expalin: 'explain',
  implmentation: 'implementation', implemenation: 'implementation', intial: 'initial', paramter: 'parameter',
  paramaters: 'parameters', perfomance: 'performance', refector: 'refactor', reponse: 'response',
  requst: 'request', reuqest: 'request', sumary: 'summary', sumarize: 'summarize', summerize: 'summarize',
  summarise: 'summarize', udpate: 'update', upate: 'update', varible: 'variable', varaible: 'variable',
  adn: 'and', nad: 'and', taht: 'that', thsi: 'this', tihs: 'this', fo: 'of', ot: 'to', si: 'is', ti: 'it',
  ni: 'in', cant: "can't", wont: "won't", im: "I'm", ive: "I've", id: "I'd", didnt: "didn't",
  doesnt: "doesn't", isnt: "isn't", wasnt: "wasn't", youre: "you're", theyre: "they're", thats: "that's",
  whats: "what's", hasnt: "hasn't", couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't",
  arent: "aren't", werent: "weren't", lets: "let's", recieve: 'receive', recieved: 'received',
  reciept: 'receipt', seperate: 'separate', definately: 'definitely', definitly: 'definitely',
  occured: 'occurred', occuring: 'occurring', untill: 'until', wich: 'which', becuase: 'because',
  becasue: 'because', beleive: 'believe', freind: 'friend', thier: 'their', adress: 'address',
  accomodate: 'accommodate', acheive: 'achieve', arguement: 'argument', calender: 'calendar',
  collegue: 'colleague', comming: 'coming', enviroment: 'environment', existance: 'existence',
  goverment: 'government', grammer: 'grammar', happend: 'happened', immediatly: 'immediately',
  independant: 'independent', knowlege: 'knowledge', libary: 'library', neccessary: 'necessary',
  necesary: 'necessary', occassion: 'occasion', occurence: 'occurrence', posession: 'possession',
  publically: 'publicly', realy: 'really', recomend: 'recommend', refered: 'referred', relevent: 'relevant',
  responsability: 'responsibility', rythm: 'rhythm', succesful: 'successful', sucessful: 'successful',
  suprise: 'surprise', tommorow: 'tomorrow', tommorrow: 'tomorrow', truely: 'truly', wierd: 'weird',
  writting: 'writing', buisness: 'business', bussiness: 'business', begining: 'beginning', beleif: 'belief',
  concious: 'conscious', embarass: 'embarrass', excercise: 'exercise', foriegn: 'foreign', gaurd: 'guard',
  harrass: 'harass', jewelery: 'jewelry', judgement: 'judgment', maintainance: 'maintenance',
  millenium: 'millennium', mispell: 'misspell', noticable: 'noticeable', ocasion: 'occasion',
  paralel: 'parallel', pavillion: 'pavilion', persistant: 'persistent', posible: 'possible',
  priviledge: 'privilege', pronounciation: 'pronunciation', questionaire: 'questionnaire',
  reccomend: 'recommend', refrence: 'reference', rember: 'remember', remeber: 'remember', seige: 'siege',
  sieze: 'seize', sincerly: 'sincerely', speach: 'speech', strenght: 'strength', tounge: 'tongue',
  vaccuum: 'vacuum', vegtable: 'vegetable', wether: 'whether', wendsday: 'wednesday', wensday: 'wednesday',
  acheived: 'achieved', managment: 'management', developement: 'development', enviromental: 'environmental',
  experiance: 'experience', proffesional: 'professional', proffessional: 'professional', shedule: 'schedule',
  sheduled: 'scheduled', thru: 'through', tho: 'though', ur: 'your', u: 'you', pls: 'please', plz: 'please',
  thx: 'thanks', becouse: 'because', alot: 'a lot', favourite: 'favorite', colour: 'color',
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) d[i][0] = i
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[m][n]
}

function matchCase(source: string, target: string): string {
  if (source === source.toUpperCase() && source.length > 1) return target.toUpperCase()
  if (source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) return target[0].toUpperCase() + target.slice(1)
  return target
}

export function rankSuggestions(word: string, suggestions: string[]): string[] {
  const lower = word.toLowerCase()
  const out: string[] = []
  const known = TYPOS[lower]
  if (known) out.push(matchCase(word, known))
  const scored = suggestions
    .filter((s) => s && s.toLowerCase() !== lower)
    .map((s, i) => {
      const sl = s.toLowerCase()
      const dist = editDistance(lower, sl)
      const rank = commonRank(sl)
      const common = rank === Infinity ? 3 : rank < 1000 ? 0 : rank < 4000 ? 1 : 2
      const lenDiff = Math.abs(s.length - word.length)
      // A capitalized suggestion for a lowercase word is a proper noun: rank it after same-case candidates.
      const casePenalty = word[0] === word[0].toLowerCase() && s[0] !== s[0].toLowerCase() ? 25 : 0
      return { s, key: dist * 100 + common * 10 + lenDiff + casePenalty + i / 100 }
    })
    .sort((x, y) => x.key - y.key)
  for (const { s } of scored) {
    const cased = matchCase(word, s)
    if (!out.some((o) => o.toLowerCase() === cased.toLowerCase())) out.push(cased)
  }
  return out.slice(0, 5)
}

export function knownTypo(word: string): string | undefined {
  const fix = TYPOS[word.toLowerCase()]
  return fix ? matchCase(word, fix) : undefined
}
